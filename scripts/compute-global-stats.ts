/**
 * Compute Global Stats
 *
 * This script fetches all reviews from Supabase and computes global aggregate
 * statistics. The results are written to static/global-stats.json.
 *
 * Hours Suffered Calculation:
 * For each review: workload (hours/week) × semester_weeks
 * - Spring (sp) and Fall (fa): 16 weeks
 * - Summer (sm): 11 weeks
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
  semester: string;
  workload: number;
}

interface GlobalStats {
  hoursSuffered: number;
  semesterWeeks: {
    spring: number;
    fall: number;
    summer: number;
  };
}

const SEMESTER_WEEKS: Record<string, number> = {
  sp: 16, // Spring
  fa: 16, // Fall
  sm: 11, // Summer
};

function getSemesterWeeks(semester: string): number {
  return SEMESTER_WEEKS[semester] ?? 16; // Default to 16 if unknown
}

async function main() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    console.error('Missing required environment variables: SUPABASE_URL, SUPABASE_SERVICE_KEY');
    process.exit(1);
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
      .select('course_id, semester, workload')
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

  console.log(`Fetched ${allReviews.length} reviews`);

  // Calculate hours suffered
  // For each review: workload (hours/week) × semester_weeks
  let hoursSuffered = 0;
  let reviewsWithWorkload = 0;

  for (const review of allReviews) {
    if (review.workload != null && review.semester != null) {
      const weeks = getSemesterWeeks(review.semester);
      hoursSuffered += review.workload * weeks;
      reviewsWithWorkload++;
    }
  }

  console.log(`Processed ${reviewsWithWorkload} reviews with workload data`);
  console.log(`Total hours suffered: ${Math.round(hoursSuffered).toLocaleString()}`);

  const globalStats: GlobalStats = {
    hoursSuffered: Math.round(hoursSuffered),
    semesterWeeks: {
      spring: SEMESTER_WEEKS.sp,
      fall: SEMESTER_WEEKS.fa,
      summer: SEMESTER_WEEKS.sm,
    },
  };

  writeStatsFile(globalStats);
}

function writeStatsFile(stats: GlobalStats) {
  const outputPath = path.join(__dirname, '..', 'static', 'global-stats.json');
  const outputDir = path.dirname(outputPath);

  // Ensure the directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  fs.writeFileSync(outputPath, JSON.stringify(stats, null, 2) + '\n');
  console.log(`Wrote stats to ${outputPath}`);
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
