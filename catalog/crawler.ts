#!/usr/bin/env npx tsx
/**
 * OMSCS Catalog Crawler
 * Fetches courses and specializations from omscs.gatech.edu
 * Outputs JSON files to static/ directory
 *
 * Usage:
 *   npx tsx catalog/crawler.ts
 *   npx tsx catalog/crawler.ts --dry-run    # Don't write changes
 */

import * as fs from 'fs';
import * as path from 'path';

const BASE_URL = 'https://omscs.gatech.edu';
const URLS = {
  currentCourses: `${BASE_URL}/current-courses`,
  specializations: `${BASE_URL}/specializations`,
};

// Specialization URL paths mapped to their IDs
const SPECIALIZATION_URLS: Record<string, { id: string; name: string }> = {
  '/specialization-machine-learning': { id: 'cs:ml', name: 'Machine Learning' },
  '/specialization-computing-systems': { id: 'cs:cs', name: 'Computing Systems' },
  '/specialization-computational-perception-and-robotics': {
    id: 'cs:cpr',
    name: 'Computational Perception and Robotics',
  },
  '/specialization-artificial-intelligence-formerly-interactive-intelligence': {
    id: 'cs:ai',
    name: 'Artificial Intelligence',
  },
  '/specialization-human-computer-interaction': {
    id: 'cs:hci',
    name: 'Human-Computer Interaction',
  },
  '/specialization-computer-graphics': { id: 'cs:cg', name: 'Computer Graphics' },
};

const STATIC_DIR = 'static';

interface Course {
  courseId: string;
  name: string;
  departmentId: string;
  courseNumber: string;
  url: string | null;
  isFoundational: boolean;
  aliases: string[];
  isDeprecated: boolean;
}

interface SpecializationCourseGroup {
  name: string;
  pickCount: number;
  courseIds: string[];
}

interface Specialization {
  specializationId: string;
  name: string;
  programId: string;
  coreCourses: SpecializationCourseGroup[];
  electiveCourseIds: string[];
}

/**
 * Decode HTML entities like &nbsp; &amp; etc.
 */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&ndash;/g, '–')
    .replace(/&mdash;/g, '—')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Fetch HTML content from a URL
 */
async function fetchPage(url: string): Promise<string> {
  console.log(`  Fetching ${url}...`);
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'OMSCS-Catalog-Crawler/1.0',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }

  return response.text();
}

/**
 * Parse course text like "CS 6601 Artificial Intelligence" or "CS 8803 O08: Compilers"
 */
function parseCourseText(
  text: string,
  url: string | null,
  isFoundational: boolean
): Course | null {
  const match = text.match(/^([A-Z]{2,4})\s*(\d{4})(?:\s*([A-Z]\d{2}))?[:\s]+(.+)$/);
  if (!match) {
    return null;
  }

  const [, subject, number, specialTopicCode, name] = match;

  let courseId: string;
  let courseNumber: string;

  if (specialTopicCode) {
    courseId = `${subject}-${number}-${specialTopicCode}`;
    courseNumber = `${number}-${specialTopicCode}`;
  } else {
    courseId = `${subject}-${number}`;
    courseNumber = number;
  }

  return {
    courseId,
    name: name.trim(),
    departmentId: subject,
    courseNumber,
    url,
    isFoundational,
    aliases: [],
    isDeprecated: false,
  };
}

/**
 * Parse a course from HTML list item
 */
function parseCourseFromHtml(itemHtml: string): Course | null {
  const isFoundational = itemHtml.includes('*');

  const linkMatch = itemHtml.match(/<a[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/i);
  if (!linkMatch) {
    const text = decodeHtmlEntities(itemHtml.replace(/<[^>]+>/g, '').replace(/\*/g, ''));
    return parseCourseText(text, null, isFoundational);
  }

  const [, urlPath, text] = linkMatch;
  const cleanText = decodeHtmlEntities(text.replace(/\*/g, ''));
  const url = urlPath.startsWith('http') ? urlPath : `${BASE_URL}${urlPath}`;

  return parseCourseText(cleanText, url, isFoundational);
}

/**
 * Crawl current courses page
 */
async function crawlCurrentCourses(): Promise<Course[]> {
  const html = await fetchPage(URLS.currentCourses);
  const courses: Course[] = [];

  const listItemRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let match;

  while ((match = listItemRegex.exec(html)) !== null) {
    const course = parseCourseFromHtml(match[1]);
    if (course) {
      courses.push(course);
    }
  }

  return courses;
}

/**
 * Extract course ID from text like "CS 6515 Introduction to Graduate Algorithms"
 */
function extractCourseId(text: string): string | null {
  const match = text.match(/^([A-Z]{2,4})\s*(\d{4})(?:\s*([A-Z]\d{2}))?/);
  if (!match) return null;

  const [, subject, number, specialTopicCode] = match;
  if (specialTopicCode) {
    return `${subject}-${number}-${specialTopicCode}`;
  }
  return `${subject}-${number}`;
}

/**
 * Parse a specialization page to extract core courses and electives
 */
async function crawlSpecialization(
  urlPath: string,
  specInfo: { id: string; name: string }
): Promise<Specialization> {
  const url = `${BASE_URL}${urlPath}`;
  const html = await fetchPage(url);

  const coreCourses: SpecializationCourseGroup[] = [];
  const electiveCourseIds: string[] = [];

  // First, try to find a "Core Courses" section header followed directly by a list
  const directCoreRegex =
    /<h4[^>]*>Core Courses\s*\(\d+\s*hours?\)<\/h4>\s*<(?:ul|ol)[^>]*>([\s\S]*?)<\/(?:ul|ol)>/i;

  const directCoreMatch = directCoreRegex.exec(html);
  if (directCoreMatch) {
    const listHtml = directCoreMatch[1];
    const courseIds: string[] = [];
    const listItemRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
    let itemMatch;

    while ((itemMatch = listItemRegex.exec(listHtml)) !== null) {
      const itemText = decodeHtmlEntities(itemMatch[1].replace(/<[^>]+>/g, ''));
      const courseMatches = itemText.match(/([A-Z]{2,4})\s*(\d{4})(?:\s*([A-Z]\d{2}))?/g);
      if (courseMatches) {
        for (const courseMatch of courseMatches) {
          const id = extractCourseId(courseMatch);
          if (id) courseIds.push(id);
        }
      }
    }

    if (courseIds.length > 0) {
      coreCourses.push({ name: 'Core', pickCount: courseIds.length, courseIds });
    }
  }

  // Find all course groups with headers
  const groupRegex =
    /<(?:p|strong|b)[^>]*>(?:<u>)?\s*([^<]*?)(?::\s*)?(?:pick|take|select)?\s*(?:one|two|three|four|five|\d+)?\s*\((\d+)\)\s*(?:courses?\s+)?(?:of|from)?:?\s*(?:<\/u>)?<\/(?:p|strong|b)>\s*<(?:ul|ol)[^>]*>([\s\S]*?)<\/(?:ul|ol)>/gi;

  let groupMatch;
  while ((groupMatch = groupRegex.exec(html)) !== null) {
    const groupName = decodeHtmlEntities(groupMatch[1].trim());
    const pickCount = parseInt(groupMatch[2], 10);
    const listHtml = groupMatch[3];

    if (groupName.toLowerCase().includes('elective') || groupName.toLowerCase().includes('free')) {
      continue;
    }

    const courseIds: string[] = [];
    const listItemRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
    let itemMatch;

    while ((itemMatch = listItemRegex.exec(listHtml)) !== null) {
      const itemText = decodeHtmlEntities(itemMatch[1].replace(/<[^>]+>/g, ''));
      const courseId = extractCourseId(itemText);
      if (courseId) {
        courseIds.push(courseId);
      }
    }

    if (courseIds.length > 0) {
      coreCourses.push({ name: groupName, pickCount, courseIds });
    }
  }

  // Try to find electives section
  const electiveMatch = html.match(
    /<(?:strong|b|p|h\d)[^>]*>[^<]*Electives?\s*\([^)]*hours?[^)]*\)[^<]*<\/(?:strong|b|p|h\d)>\s*[\s\S]*?<(?:ul|ol)[^>]*>([\s\S]*?)<\/(?:ul|ol)>/i
  );

  if (electiveMatch) {
    const listHtml = electiveMatch[1];
    const listItemRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
    let itemMatch;

    while ((itemMatch = listItemRegex.exec(listHtml)) !== null) {
      const itemText = decodeHtmlEntities(itemMatch[1].replace(/<[^>]+>/g, ''));
      const courseId = extractCourseId(itemText);
      if (courseId) {
        electiveCourseIds.push(courseId);
      }
    }
  }

  return {
    specializationId: specInfo.id,
    name: specInfo.name,
    programId: 'cs',
    coreCourses,
    electiveCourseIds,
  };
}

/**
 * Crawl all OMSCS specializations
 */
async function crawlAllSpecializations(): Promise<Specialization[]> {
  const specializations: Specialization[] = [];

  for (const [urlPath, specInfo] of Object.entries(SPECIALIZATION_URLS)) {
    try {
      console.log(`  Crawling ${specInfo.name}...`);
      const spec = await crawlSpecialization(urlPath, specInfo);
      specializations.push(spec);
      console.log(
        `    Found ${spec.coreCourses.length} core groups, ${spec.electiveCourseIds.length} electives`
      );
    } catch (error) {
      console.error(`  Error crawling ${specInfo.name}: ${(error as Error).message}`);
    }
  }

  return specializations;
}

/**
 * Load existing courses data from static directory
 */
function loadExistingCourses(): Record<string, Course> | null {
  const filePath = path.join(STATIC_DIR, 'courses.json');
  if (fs.existsSync(filePath)) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      console.warn('Failed to load existing courses.json');
    }
  }
  return null;
}

/**
 * Load existing specializations data from static directory
 */
function loadExistingSpecializations(): Record<string, Specialization> | null {
  const filePath = path.join(STATIC_DIR, 'specializations.json');
  if (fs.existsSync(filePath)) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      console.warn('Failed to load existing specializations.json');
    }
  }
  return null;
}

/**
 * Merge crawled courses with existing data
 */
function mergeCourses(
  crawledCourses: Course[],
  existingCourses: Record<string, Course> | null
): { courses: Record<string, Course>; newCourses: string[] } {
  const courses: Record<string, Course> = existingCourses || {};
  const newCourses: string[] = [];

  for (const course of crawledCourses) {
    if (!courses[course.courseId]) {
      newCourses.push(course.courseId);
      courses[course.courseId] = course;
      console.log(`  + New course: ${course.courseId} - ${course.name}`);
    } else {
      // Preserve existing aliases, deprecated status, and isFoundational
      courses[course.courseId] = {
        ...course,
        aliases: courses[course.courseId].aliases || [],
        isDeprecated: courses[course.courseId].isDeprecated || false,
        isFoundational: courses[course.courseId].isFoundational,
      };
    }
  }

  return { courses, newCourses };
}

/**
 * Merge crawled specializations with existing data
 */
function mergeSpecializations(
  crawledSpecs: Specialization[],
  existingSpecs: Record<string, Specialization> | null
): Record<string, Specialization> {
  const specializations: Record<string, Specialization> = existingSpecs || {};

  for (const spec of crawledSpecs) {
    specializations[spec.specializationId] = spec;
  }

  return specializations;
}

async function main(): Promise<void> {
  const isDryRun = process.argv.includes('--dry-run');

  console.log('='.repeat(60));
  console.log('OMSCS Catalog Crawler');
  console.log('='.repeat(60));

  if (isDryRun) {
    console.log('Running in dry-run mode (no changes will be written)');
  }

  // Ensure output directory exists
  if (!isDryRun) {
    if (!fs.existsSync(STATIC_DIR)) {
      fs.mkdirSync(STATIC_DIR, { recursive: true });
    }
  }

  // Load existing data
  const existingCourses = loadExistingCourses();
  const existingSpecs = loadExistingSpecializations();

  if (existingCourses) {
    console.log(`\nLoaded ${Object.keys(existingCourses).length} existing courses`);
  }

  // Crawl current courses
  console.log('\nCrawling current courses...');
  const crawledCourses = await crawlCurrentCourses();
  console.log(`  Found ${crawledCourses.length} courses on website`);

  // Merge courses
  console.log('\nMerging courses...');
  const { courses, newCourses } = mergeCourses(crawledCourses, existingCourses);

  // Crawl specializations
  console.log('\nCrawling specializations...');
  const crawledSpecs = await crawlAllSpecializations();
  console.log(`  Crawled ${crawledSpecs.length} specializations`);

  // Merge specializations
  const specializations = mergeSpecializations(crawledSpecs, existingSpecs);

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('Summary');
  console.log('='.repeat(60));
  console.log(`Total courses: ${Object.keys(courses).length}`);
  console.log(`New courses: ${newCourses.length}`);
  if (newCourses.length > 0) {
    for (const id of newCourses) {
      console.log(`  + ${id}`);
    }
  }
  console.log(`Specializations: ${Object.keys(specializations).length}`);
  console.log('='.repeat(60));

  if (!isDryRun) {
    // Write courses to static directory
    const coursesPath = path.join(STATIC_DIR, 'courses.json');
    fs.writeFileSync(coursesPath, JSON.stringify(courses, null, 2));
    console.log(`\nWrote ${coursesPath}`);

    // Write specializations to static directory
    const specsPath = path.join(STATIC_DIR, 'specializations.json');
    fs.writeFileSync(specsPath, JSON.stringify(specializations, null, 2));
    console.log(`Wrote ${specsPath}`);
  }
}

main().catch((error) => {
  console.error('Crawler failed:', error);
  process.exit(1);
});
