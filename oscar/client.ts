/**
 * OSCAR Client - Fetches course data from GitHub-hosted JSON files
 * Use this in Next.js app pages/components to get OMSCS course data
 */

import type { TermData, Catalog, Course } from './types.js';

// Re-export types for convenience
export type { Course, Section, TermData, Catalog, CatalogCourse } from './types.js';

// Configuration
const GITHUB_RAW_BASE = 'https://raw.githubusercontent.com';
const REPO_OWNER = process.env.NEXT_PUBLIC_GITHUB_OWNER || 'YOUR_USERNAME';
const REPO_NAME = process.env.NEXT_PUBLIC_GITHUB_REPO || 'website';
const DATA_BRANCH = 'data';

// Cache durations (in seconds)
const CACHE_DURATION_SEATS = 5 * 60; // 5 minutes for seat data
const CACHE_DURATION_CATALOG = 60 * 60; // 1 hour for catalog

function getDataUrl(filename: string): string {
  return `${GITHUB_RAW_BASE}/${REPO_OWNER}/${REPO_NAME}/${DATA_BRANCH}/data/${filename}`;
}

/**
 * Fetch term data (sections and seat counts) for a specific term
 */
export async function getOscarTermData(termCode: string): Promise<TermData | null> {
  try {
    const url = getDataUrl(`${termCode}.json`);
    const response = await fetch(url, {
      next: { revalidate: CACHE_DURATION_SEATS },
    });

    if (!response.ok) {
      if (response.status === 404) {
        console.warn(`Term data not found for ${termCode}`);
        return null;
      }
      throw new Error(`Failed to fetch term data: ${response.status}`);
    }

    return (await response.json()) as TermData;
  } catch (error) {
    console.error(`Error fetching term data for ${termCode}:`, error);
    return null;
  }
}

/**
 * Fetch the course catalog (all courses across terms)
 */
export async function getOscarCatalog(): Promise<Catalog | null> {
  try {
    const url = getDataUrl('catalog.json');
    const response = await fetch(url, {
      next: { revalidate: CACHE_DURATION_CATALOG },
    });

    if (!response.ok) {
      if (response.status === 404) {
        console.warn('Course catalog not found');
        return null;
      }
      throw new Error(`Failed to fetch catalog: ${response.status}`);
    }

    return (await response.json()) as Catalog;
  } catch (error) {
    console.error('Error fetching catalog:', error);
    return null;
  }
}

/**
 * Get seat availability for a specific course in a term
 */
export async function getCourseSeats(
  courseId: string,
  termCode: string
): Promise<Course | null> {
  const termData = await getOscarTermData(termCode);
  if (!termData) return null;

  return termData.courses[courseId] || null;
}

/**
 * Get current term code based on date
 */
export function getCurrentTermCode(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;

  if (month >= 1 && month <= 4) {
    return `${year}02`; // Spring
  } else if (month >= 5 && month <= 7) {
    return `${year}05`; // Summer
  } else {
    return `${year}08`; // Fall
  }
}

/**
 * Get term name from code
 */
export function getTermName(termCode: string): string {
  const year = termCode.substring(0, 4);
  const semester = termCode.substring(4);

  switch (semester) {
    case '02':
      return `Spring ${year}`;
    case '05':
      return `Summer ${year}`;
    case '08':
      return `Fall ${year}`;
    default:
      return `${year}`;
  }
}
