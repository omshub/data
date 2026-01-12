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
 * Extract section content between two headers
 */
function extractSectionContent(html: string, sectionName: string, nextSectionNames: string[]): string | null {
  // Build regex to find section header - looking for h3 or h4 containing the section name
  const sectionHeaderRegex = new RegExp(
    `<h[34][^>]*>\\s*${sectionName}\\s*\\([^)]*\\)\\s*<\\/h[34]>`,
    'i'
  );

  const headerMatch = sectionHeaderRegex.exec(html);
  if (!headerMatch) return null;

  const startIndex = headerMatch.index + headerMatch[0].length;

  // Find the next section header (h3 or h4)
  let endIndex = html.length;
  for (const nextSection of nextSectionNames) {
    const nextRegex = new RegExp(
      `<h[34][^>]*>\\s*${nextSection}\\s*(?:\\([^)]*\\))?\\s*<\\/h[34]>`,
      'i'
    );
    const nextMatch = nextRegex.exec(html.substring(startIndex));
    if (nextMatch && startIndex + nextMatch.index < endIndex) {
      endIndex = startIndex + nextMatch.index;
    }
  }

  // Also look for any h3/h4 that might end the section
  const anyHeaderRegex = /<h[34][^>]*>/gi;
  let anyHeaderMatch;
  const tempHtml = html.substring(startIndex, endIndex);
  while ((anyHeaderMatch = anyHeaderRegex.exec(tempHtml)) !== null) {
    // Found another header - this ends our section
    if (startIndex + anyHeaderMatch.index < endIndex) {
      endIndex = startIndex + anyHeaderMatch.index;
      break;
    }
  }

  return html.substring(startIndex, endIndex);
}

/**
 * Parse courses from HTML content, extracting "pick X" groups
 */
function parseCoursesFromSection(sectionHtml: string): { groups: SpecializationCourseGroup[]; courseIds: string[] } {
  const groups: SpecializationCourseGroup[] = [];
  const allCourseIds: string[] = [];

  // Pattern 1: Look for "pick X" or "Pick X (N)" patterns followed by lists
  const pickPatternRegex = /(?:pick|take|select)\s+(?:one|two|three|four|five|(\d+))(?:\s*\((\d+)\))?[^<]*(?:from|of)?:?\s*<\/(?:li|p|strong|b)>\s*(?:<(?:ul|ol)[^>]*>([\s\S]*?)<\/(?:ul|ol)>)?/gi;

  let match;
  while ((match = pickPatternRegex.exec(sectionHtml)) !== null) {
    const wordToNum: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };
    const pickText = match[0].toLowerCase();
    let pickCount = 1;

    // Extract pick count from word or number
    for (const [word, num] of Object.entries(wordToNum)) {
      if (pickText.includes(word)) {
        pickCount = num;
        break;
      }
    }
    if (match[1]) pickCount = parseInt(match[1], 10);
    if (match[2]) pickCount = parseInt(match[2], 10);

    // Extract courses from the list if present
    if (match[3]) {
      const courseIds: string[] = [];
      const listItemRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
      let itemMatch;

      while ((itemMatch = listItemRegex.exec(match[3])) !== null) {
        const itemText = decodeHtmlEntities(itemMatch[1].replace(/<[^>]+>/g, ''));
        const courseId = extractCourseId(itemText);
        if (courseId && !courseIds.includes(courseId)) {
          courseIds.push(courseId);
        }
      }

      if (courseIds.length > 0) {
        groups.push({ name: `Pick ${pickCount}`, pickCount, courseIds });
      }
    }
  }

  // Pattern 2: Also look for standalone lists with course items (for simpler formats)
  // Extract all course IDs from the section for flat lists
  const allListItemRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  while ((match = allListItemRegex.exec(sectionHtml)) !== null) {
    const itemText = decodeHtmlEntities(match[1].replace(/<[^>]+>/g, ''));
    const courseId = extractCourseId(itemText);
    if (courseId && !allCourseIds.includes(courseId)) {
      allCourseIds.push(courseId);
    }
  }

  return { groups, courseIds: allCourseIds };
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

  // Extract Core Courses section (between "Core Courses" and "Electives" headers)
  const coreSection = extractSectionContent(html, 'Core Courses', ['Electives', 'Free Electives']);

  if (coreSection) {
    // Parse the core courses section structure
    // The structure can be:
    // - List + "or" + List = Pick 1 group (alternatives)
    // - "And, pick X of:" + List = Pick X group

    // Split by "And," or "pick X" instructions to identify groups
    // First, identify segments: list before "And," is pick 1, list after "And, pick X" is pick X

    // Find all lists with their positions
    const listsWithPos: Array<{ html: string; startPos: number; endPos: number }> = [];
    const listsRegex = /<(?:ul|ol)[^>]*>([\s\S]*?)<\/(?:ul|ol)>/gi;
    let listMatch;

    while ((listMatch = listsRegex.exec(coreSection)) !== null) {
      listsWithPos.push({
        html: listMatch[1],
        startPos: listMatch.index,
        endPos: listMatch.index + listMatch[0].length
      });
    }

    // Find "And, pick X" instructions with positions
    const andPickRegex = /and,?\s*pick\s+(?:one|two|three|four|five|(\d+))(?:\s*\((\d+)\))?/gi;
    const andPickPositions: Array<{ pickCount: number; pos: number }> = [];

    let andMatch;
    while ((andMatch = andPickRegex.exec(coreSection)) !== null) {
      const wordToNum: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };
      let pickCount = 2; // default for "and pick"

      const text = andMatch[0].toLowerCase();
      for (const [word, num] of Object.entries(wordToNum)) {
        if (text.includes(word)) {
          pickCount = num;
          break;
        }
      }
      if (andMatch[1]) pickCount = parseInt(andMatch[1], 10);
      if (andMatch[2]) pickCount = parseInt(andMatch[2], 10);

      andPickPositions.push({ pickCount, pos: andMatch.index });
    }

    // Check for "or" between lists (indicates pick 1 alternatives)
    const hasOrBetweenLists = /<\/(?:ul|ol)>\s*<p[^>]*>\s*or\s*<\/p>\s*<(?:ul|ol)/i.test(coreSection);

    if (andPickPositions.length > 0) {
      // We have "And, pick X" - lists before it are pick 1, lists after are pick X
      const firstAndPos = andPickPositions[0].pos;

      // Collect courses from lists BEFORE "And, pick X" (these are pick 1 alternatives)
      const pick1Ids: string[] = [];
      for (const list of listsWithPos) {
        if (list.endPos < firstAndPos) {
          const listItemRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
          let itemMatch;
          while ((itemMatch = listItemRegex.exec(list.html)) !== null) {
            const itemText = decodeHtmlEntities(itemMatch[1].replace(/<[^>]+>/g, ''));
            const courseId = extractCourseId(itemText);
            if (courseId && !pick1Ids.includes(courseId)) {
              pick1Ids.push(courseId);
            }
          }
        }
      }

      if (pick1Ids.length > 0) {
        coreCourses.push({ name: 'Pick 1', pickCount: 1, courseIds: pick1Ids });
      }

      // Process each "And, pick X" section
      for (let i = 0; i < andPickPositions.length; i++) {
        const andPick = andPickPositions[i];
        const nextAndPos = i + 1 < andPickPositions.length
          ? andPickPositions[i + 1].pos
          : coreSection.length;

        // Find lists after this "And, pick X" and before the next one
        const pickXIds: string[] = [];
        for (const list of listsWithPos) {
          if (list.startPos > andPick.pos && list.startPos < nextAndPos) {
            const listItemRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
            let itemMatch;
            while ((itemMatch = listItemRegex.exec(list.html)) !== null) {
              const itemText = decodeHtmlEntities(itemMatch[1].replace(/<[^>]+>/g, ''));
              // Skip non-course items like "Any Core Courses in excess..."
              if (itemText.toLowerCase().includes('any core courses') ||
                  itemText.toLowerCase().includes('any special topics')) {
                continue;
              }
              const courseId = extractCourseId(itemText);
              if (courseId && !pickXIds.includes(courseId)) {
                pickXIds.push(courseId);
              }
            }
          }
        }

        if (pickXIds.length > 0) {
          coreCourses.push({
            name: `Pick ${andPick.pickCount}`,
            pickCount: andPick.pickCount,
            courseIds: pickXIds
          });
        }
      }
    } else if (hasOrBetweenLists) {
      // No "And, pick X" but has "or" - all lists are pick 1 alternatives
      const pick1Ids: string[] = [];
      for (const list of listsWithPos) {
        const listItemRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
        let itemMatch;
        while ((itemMatch = listItemRegex.exec(list.html)) !== null) {
          const itemText = decodeHtmlEntities(itemMatch[1].replace(/<[^>]+>/g, ''));
          const courseId = extractCourseId(itemText);
          if (courseId && !pick1Ids.includes(courseId)) {
            pick1Ids.push(courseId);
          }
        }
      }
      if (pick1Ids.length > 0) {
        coreCourses.push({ name: 'Pick 1', pickCount: 1, courseIds: pick1Ids });
      }
    } else {
      // Fallback: look for any "pick X" instructions
      const pickRegex = /pick\s+(?:one|two|three|four|five|(\d+))(?:\s*\((\d+)\))?/gi;
      const pickInstructions: number[] = [];

      let pickMatch;
      while ((pickMatch = pickRegex.exec(coreSection)) !== null) {
        const wordToNum: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };
        let pickCount = 1;

        const text = pickMatch[0].toLowerCase();
        for (const [word, num] of Object.entries(wordToNum)) {
          if (text.includes(word)) {
            pickCount = num;
            break;
          }
        }
        if (pickMatch[1]) pickCount = parseInt(pickMatch[1], 10);
        if (pickMatch[2]) pickCount = parseInt(pickMatch[2], 10);

        if (!pickInstructions.includes(pickCount)) {
          pickInstructions.push(pickCount);
        }
      }

      // Extract all courses and assign to pick instructions
      const allCoreIds: string[] = [];
      const listItemRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
      let itemMatch;

      while ((itemMatch = listItemRegex.exec(coreSection)) !== null) {
        const itemText = decodeHtmlEntities(itemMatch[1].replace(/<[^>]+>/g, ''));
        const courseId = extractCourseId(itemText);
        if (courseId && !allCoreIds.includes(courseId)) {
          allCoreIds.push(courseId);
        }
      }

      if (allCoreIds.length > 0) {
        const pickCount = pickInstructions.length > 0 ? pickInstructions[0] : allCoreIds.length;
        coreCourses.push({ name: 'Core', pickCount, courseIds: allCoreIds });
      }
    }
  }

  // Extract Electives section (between "Electives" and "Free Electives" headers)
  const electiveSection = extractSectionContent(html, 'Electives', ['Free Electives']);

  if (electiveSection) {
    // Extract all course IDs from electives section
    const listItemRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
    let itemMatch;

    while ((itemMatch = listItemRegex.exec(electiveSection)) !== null) {
      const itemText = decodeHtmlEntities(itemMatch[1].replace(/<[^>]+>/g, ''));

      // Skip instruction lines
      if (itemText.toLowerCase().includes('pick ') && !extractCourseId(itemText)) {
        continue;
      }

      const courseId = extractCourseId(itemText);
      if (courseId && !electiveCourseIds.includes(courseId)) {
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
