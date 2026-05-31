/**
 * Parser to transform Banner 9 API responses to our normalized schema
 * Focused on seat counts and course catalog only
 */

import type {
  BannerSection,
  Course,
  Section,
  TermData,
  Catalog,
} from './types.js';
import { config } from './config.js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

/**
 * Get primary instructor from faculty list
 */
function getPrimaryInstructor(section: BannerSection): string | null {
  for (const faculty of section.faculty || []) {
    if (faculty.primaryIndicator) {
      return faculty.displayName || null;
    }
  }
  // Return first instructor if no primary found
  return section.faculty?.[0]?.displayName || null;
}

/**
 * Special topics course numbers where each section is a different course
 * These need section-specific IDs (e.g., CS-8803-O08 for Compilers)
 */
const SPECIAL_TOPICS_COURSES = ['8803', '8813', '8823'];
interface StaticCourse {
  name?: string;
}

let catalogCourses: Record<string, StaticCourse> | null = null;

function getCatalogCourses(): Record<string, StaticCourse> {
  if (catalogCourses) {
    return catalogCourses;
  }

  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const coursesPath = path.resolve(currentDir, '../static/courses.json');

  try {
    catalogCourses = JSON.parse(
      fs.readFileSync(coursesPath, 'utf-8')
    ) as Record<string, StaticCourse>;
  } catch {
    catalogCourses = {};
  }

  return catalogCourses;
}

/**
 * Generate course ID from subject, course number, and optionally section
 * Format: CS-6035, ISYE-6501, CS-8803-O08, etc.
 *
 * For special topics courses (8803, 8813, 8823), each section is a different
 * course with a different title, so we include the section number in the ID.
 */
function generateCourseId(
  subject: string,
  courseNumber: string,
  sectionNumber?: string
): string {
  const baseCourseId = `${subject}-${courseNumber}`;
  const sectionCourseId = sectionNumber
    ? `${baseCourseId}-${sectionNumber}`
    : baseCourseId;
  const courses = getCatalogCourses();

  if (courses[sectionCourseId]) {
    return sectionCourseId;
  }

  if (courses[baseCourseId]) {
    return baseCourseId;
  }

  if (SPECIAL_TOPICS_COURSES.includes(courseNumber) && sectionNumber) {
    return sectionCourseId;
  }
  return baseCourseId;
}

function getCatalogCourseName(courseId: string): string | null {
  return getCatalogCourses()[courseId]?.name || null;
}

function removeStaleSectionSpecificEntries(
  courses: Record<string, Catalog['courses'][string]>,
  course: Course
): void {
  const canonicalBaseId = `${course.subject}-${course.courseNumber}`;

  if (
    course.courseId !== canonicalBaseId ||
    !getCatalogCourses()[canonicalBaseId]
  ) {
    return;
  }

  const sectionSpecificPattern = new RegExp(`^${canonicalBaseId}-O\\d{2}$`);
  for (const existingCourseId of Object.keys(courses)) {
    if (sectionSpecificPattern.test(existingCourseId)) {
      delete courses[existingCourseId];
    }
  }
}

/**
 * Parse a Banner section to our Section format
 */
function parseSection(bannerSection: BannerSection): Section {
  return {
    crn: bannerSection.courseReferenceNumber,
    sectionNumber: bannerSection.sequenceNumber,
    instructor: getPrimaryInstructor(bannerSection),
    enrolled: bannerSection.enrollment,
    capacity: bannerSection.maximumEnrollment,
    seatsAvailable: bannerSection.seatsAvailable,
    waitCount: bannerSection.waitCount,
    waitCapacity: bannerSection.waitCapacity,
  };
}

/**
 * Check if a course number is graduate level (6000+)
 * OMSCS only offers graduate courses
 */
function isGraduateCourse(courseNumber: string): boolean {
  const num = parseInt(courseNumber, 10);
  return !isNaN(num) && num >= 6000;
}

/**
 * Check if a section is an OMSCS section (O followed by two digits)
 *
 * OMSCS students can only enroll in sections with O(two digits) codes (e.g., O01, O02)
 * - OAN sections are only for students in the OMSA (Analytics) program
 * - OCY sections are only for students in the OMS Cybersecurity program
 * - OSZ sections are only for students at Georgia Tech's Shenzhen campus
 */
function isOMSCSSection(sectionNumber: string): boolean {
  return /^O\d{2}$/.test(sectionNumber);
}

/**
 * Group sections by course and create Course objects
 * Only includes graduate-level courses (6000+) with online sections (O*)
 */
export function parseSectionsToCourses(
  sections: BannerSection[]
): Record<string, Course> {
  const courseMap: Record<string, Course> = {};

  for (const section of sections) {
    // Skip undergraduate courses
    if (!isGraduateCourse(section.courseNumber)) {
      continue;
    }

    // Skip non-OMSCS sections (must be O followed by two digits like O01)
    if (!isOMSCSSection(section.sequenceNumber)) {
      continue;
    }

    const courseId = generateCourseId(
      section.subject,
      section.courseNumber,
      section.sequenceNumber
    );

    // For section-specific special topics, include section in course number (e.g., 8803-O08)
    const courseNumber = courseId.endsWith(`-${section.sequenceNumber}`)
      ? `${section.courseNumber}-${section.sequenceNumber}`
      : section.courseNumber;

    if (!courseMap[courseId]) {
      courseMap[courseId] = {
        courseId,
        subject: section.subject,
        courseNumber,
        name: getCatalogCourseName(courseId) || section.courseTitle,
        creditHours: section.creditHours,
        sections: [],
        totalSeats: 0,
        totalEnrolled: 0,
        totalAvailable: 0,
        totalWaitlisted: 0,
      };
    }

    const course = courseMap[courseId];
    const parsedSection = parseSection(section);
    course.sections.push(parsedSection);

    // Update totals
    course.totalSeats += parsedSection.capacity;
    course.totalEnrolled += parsedSection.enrolled;
    course.totalAvailable += parsedSection.seatsAvailable;
    course.totalWaitlisted += parsedSection.waitCount;
  }

  return courseMap;
}

/**
 * Create TermData from parsed courses
 */
export function createTermData(
  termCode: string,
  courses: Record<string, Course>
): TermData {
  return {
    term: termCode,
    termName: config.getTermName(termCode),
    lastUpdated: new Date().toISOString(),
    courses,
  };
}

/**
 * Merge courses into catalog
 */
export function mergeToCatalog(
  existingCatalog: Catalog | null,
  termData: TermData
): Catalog {
  const catalog: Catalog = existingCatalog || {
    lastUpdated: new Date().toISOString(),
    courses: {},
  };

  catalog.lastUpdated = new Date().toISOString();

  for (const [courseId, course] of Object.entries(termData.courses)) {
    removeStaleSectionSpecificEntries(catalog.courses, course);

    catalog.courses[courseId] = {
      courseId: course.courseId,
      subject: course.subject,
      courseNumber: course.courseNumber,
      name: course.name,
      creditHours: course.creditHours,
      lastSeen: termData.term,
    };
  }

  return catalog;
}
