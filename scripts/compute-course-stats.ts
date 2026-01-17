/**
 * Compute Course Stats
 *
 * This script fetches all reviews from Supabase and computes aggregate
 * statistics for each course. The results are written to static/course-stats.json.
 *
 * Required environment variables:
 * - SUPABASE_URL: The Supabase project URL
 * - SUPABASE_SERVICE_KEY: The Supabase service role key (for read access)
 */

import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface Review {
  course_id: string;
  workload: number;
  difficulty: number;
  overall: number;
  staff_support: number | null;
}

interface CourseStats {
  courseId: string;
  numReviews: number;
  avgWorkload: number | null;
  avgDifficulty: number | null;
  avgOverall: number | null;
  avgStaffSupport: number | null;
}

interface CourseStatsPayload {
  [courseId: string]: CourseStats;
}

interface CourseCatalog {
  [courseId: string]: {
    courseId: string;
    name: string;
  };
}

function createEmptyStats(courseId: string): CourseStats {
  return {
    courseId,
    numReviews: 0,
    avgWorkload: null,
    avgDifficulty: null,
    avgOverall: null,
    avgStaffSupport: null,
  };
}

function loadCourseCatalog(): string[] {
  const catalogPath = path.join(__dirname, '..', 'static', 'courses.json');
  const catalogData = fs.readFileSync(catalogPath, 'utf-8');
  const catalog: CourseCatalog = JSON.parse(catalogData);
  return Object.keys(catalog);
}

async function main() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    console.error('Missing required environment variables: SUPABASE_URL, SUPABASE_SERVICE_KEY');
    process.exit(1);
  }

  // Load all courses from catalog and initialize empty stats
  console.log('Loading course catalog...');
  const allCourseIds = loadCourseCatalog();
  console.log(`Found ${allCourseIds.length} courses in catalog`);

  const courseStats: CourseStatsPayload = {};
  for (const courseId of allCourseIds) {
    courseStats[courseId] = createEmptyStats(courseId);
  }

  console.log('Connecting to Supabase...');
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  // Fetch all reviews with pagination (Supabase has a default limit of 1000)
  console.log('Fetching reviews...');
  const allReviews: Review[] = [];
  const pageSize = 1000;
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const { data: reviews, error } = await supabase
      .from('reviews')
      .select('course_id, workload, difficulty, overall, staff_support')
      .range(offset, offset + pageSize - 1);

    if (error) {
      console.error('Error fetching reviews:', error);
      process.exit(1);
    }

    if (reviews && reviews.length > 0) {
      allReviews.push(...reviews);
      offset += reviews.length;
      hasMore = reviews.length === pageSize;
    } else {
      hasMore = false;
    }
  }

  const reviews = allReviews;
  console.log(`Fetched ${reviews.length} reviews`);

  if (reviews.length === 0) {
    console.log('No reviews found, writing empty stats for all courses');
    writeStatsFile(courseStats);
    return;
  }

  // Group reviews by course
  const reviewsByCourse: Record<string, Review[]> = {};
  for (const review of reviews) {
    const courseId = review.course_id;
    if (!reviewsByCourse[courseId]) {
      reviewsByCourse[courseId] = [];
    }
    reviewsByCourse[courseId].push(review);
  }

  // Compute stats for courses that have reviews
  console.log('Computing course stats...');
  let coursesWithReviews = 0;

  for (const [courseId, courseReviews] of Object.entries(reviewsByCourse)) {
    const numReviews = courseReviews.length;

    // Calculate averages
    const workloads = courseReviews.map((r) => r.workload).filter((w) => w != null);
    const difficulties = courseReviews.map((r) => r.difficulty).filter((d) => d != null);
    const overalls = courseReviews.map((r) => r.overall).filter((o) => o != null);
    const staffSupports = courseReviews
      .map((r) => r.staff_support)
      .filter((s): s is number => s != null);

    const avg = (arr: number[]) => (arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : null);

    // Round to 2 decimal places
    const round = (val: number | null) => (val !== null ? Math.round(val * 100) / 100 : null);

    courseStats[courseId] = {
      courseId,
      numReviews,
      avgWorkload: round(avg(workloads)),
      avgDifficulty: round(avg(difficulties)),
      avgOverall: round(avg(overalls)),
      avgStaffSupport: round(avg(staffSupports)),
    };
    coursesWithReviews++;
  }

  console.log(`Computed stats for ${coursesWithReviews} courses with reviews`);
  console.log(`Total courses in output: ${Object.keys(courseStats).length}`);
  writeStatsFile(courseStats);
}

function writeStatsFile(stats: CourseStatsPayload) {
  const outputPath = path.join(__dirname, '..', 'static', 'course-stats.json');
  const outputDir = path.dirname(outputPath);

  // Ensure the directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Sort by courseId for consistent output
  const sortedStats: CourseStatsPayload = {};
  Object.keys(stats)
    .sort()
    .forEach((key) => {
      sortedStats[key] = stats[key];
    });

  fs.writeFileSync(outputPath, JSON.stringify(sortedStats, null, 2) + '\n');
  console.log(`Wrote stats to ${outputPath}`);
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
