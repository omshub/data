#!/usr/bin/env npx tsx
/**
 * OSCAR Crawler - Fetches course data from Georgia Tech's Banner 9 system
 * Run via GitHub Actions or locally to update OMSCS course data
 *
 * Usage:
 *   npx tsx oscar/crawler.ts --term 202502          # Single term
 *   npx tsx oscar/crawler.ts --all                  # Current + previous terms
 *   npx tsx oscar/crawler.ts                        # Current term only (default)
 *   npx tsx oscar/crawler.ts --dry-run              # Fetch and display but don't save
 *   npx tsx oscar/crawler.ts --skip-catalog         # Skip catalog.json generation (for parallel jobs)
 */

import * as fs from 'fs';
import * as path from 'path';
import { BannerClient } from './banner-client.js';
import { config } from './config.js';
import { parseSectionsToCourses, createTermData, mergeToCatalog } from './parser.js';
import type { Catalog, TermData } from './types.js';

interface CrawlerArgs {
  terms: string[];
  outputDir: string;
  dryRun: boolean;
  skipCatalog: boolean;
}

function parseArgs(): CrawlerArgs {
  const args = process.argv.slice(2);
  let outputDir = config.outputDir;
  let fetchAll = false;
  let specificTerm: string | null = null;
  let dryRun = false;
  let skipCatalog = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--term' && args[i + 1]) {
      specificTerm = args[i + 1];
      i++;
    } else if (args[i] === '--output' && args[i + 1]) {
      outputDir = args[i + 1];
      i++;
    } else if (args[i] === '--all') {
      fetchAll = true;
    } else if (args[i] === '--dry-run') {
      dryRun = true;
    } else if (args[i] === '--skip-catalog') {
      skipCatalog = true;
    }
  }

  // Determine which terms to fetch
  let terms: string[];
  if (specificTerm) {
    terms = [specificTerm];
  } else if (fetchAll) {
    terms = config.getAllTerms(); // Fetch ALL terms back to 2014
  } else {
    terms = [config.getCurrentTermCode()];
  }

  return { terms, outputDir, dryRun, skipCatalog };
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function loadExistingCatalog(outputDir: string): Catalog | null {
  const catalogPath = path.join(outputDir, config.catalogFilename);
  if (fs.existsSync(catalogPath)) {
    try {
      const content = fs.readFileSync(catalogPath, 'utf-8');
      return JSON.parse(content) as Catalog;
    } catch {
      console.warn('Failed to load existing catalog, starting fresh');
    }
  }
  return null;
}

function saveTermData(outputDir: string, termData: TermData): void {
  const filename = config.getTermFilename(termData.term);
  const filepath = path.join(outputDir, filename);
  fs.writeFileSync(filepath, JSON.stringify(termData, null, 2));
  console.log(`  Saved: ${filepath}`);
}

function saveCatalog(outputDir: string, catalog: Catalog): void {
  const filepath = path.join(outputDir, config.catalogFilename);
  fs.writeFileSync(filepath, JSON.stringify(catalog, null, 2));
  console.log(`Saved catalog to ${filepath}`);
}

async function fetchTerm(
  client: BannerClient,
  termCode: string
): Promise<TermData | null> {
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Fetching ${termCode} (${config.getTermName(termCode)})...`);
  console.log('─'.repeat(50));

  try {
    // Set term for this fetch
    await client.setTerm(termCode);

    // Fetch all sections for the term
    const allSections = await client.fetchAllCourses(termCode);
    console.log(`  Total sections: ${allSections.length}`);

    if (allSections.length === 0) {
      console.log(`  No data available for ${termCode}`);
      return null;
    }

    // Filter to only OMSCS-relevant subjects
    const relevantSections = allSections.filter((section) =>
      config.subjects.includes(section.subject)
    );
    console.log(`  OMSCS sections: ${relevantSections.length}`);

    // Parse sections into courses (parser also filters to graduate-level 6000+)
    const courses = parseSectionsToCourses(relevantSections);
    const courseCount = Object.keys(courses).length;
    console.log(`  Graduate courses: ${courseCount}`);

    // Create term data
    return createTermData(termCode, courses);
  } catch (error) {
    console.error(`  Error fetching ${termCode}: ${(error as Error).message}`);
    return null;
  }
}

function printTermPreview(termData: TermData): void {
  console.log(`\n  Preview of ${termData.termName}:`);
  console.log('  ' + '─'.repeat(50));

  const courses = Object.values(termData.courses).slice(0, 10);
  for (const course of courses) {
    const totalSeats = course.sections.reduce((s, sec) => s + sec.capacity, 0);
    const totalEnrolled = course.sections.reduce((s, sec) => s + sec.enrolled, 0);
    console.log(
      `  ${course.courseId.padEnd(12)} | ${course.sections.length} section(s) | ${totalEnrolled}/${totalSeats} enrolled`
    );
  }

  if (Object.keys(termData.courses).length > 10) {
    console.log(`  ... and ${Object.keys(termData.courses).length - 10} more courses`);
  }
}

async function main(): Promise<void> {
  const { terms, outputDir, dryRun, skipCatalog } = parseArgs();

  console.log('='.repeat(60));
  console.log('OSCAR Crawler');
  console.log('='.repeat(60));

  if (dryRun) {
    console.log('Running in dry-run mode (no files will be written)');
  }

  console.log(`Terms to fetch: ${terms.map((t) => config.getTermName(t)).join(', ')}`);
  console.log(`Output directory: ${outputDir}`);

  // Ensure output directory exists (only if not dry-run)
  if (!dryRun) {
    ensureDir(outputDir);
  }

  // Initialize Banner client
  const client = new BannerClient();
  await client.initSession();

  // Load existing catalog (only if not dry-run and not skip-catalog)
  let catalog = (dryRun || skipCatalog) ? null : loadExistingCatalog(outputDir);

  // Track results
  const results: { term: string; courses: number; sections: number }[] = [];

  // Fetch each term
  for (const termCode of terms) {
    const termData = await fetchTerm(client, termCode);

    if (termData) {
      if (dryRun) {
        // In dry-run mode, show preview of fetched data
        printTermPreview(termData);
      } else {
        // Save term data
        saveTermData(outputDir, termData);

        // Update catalog (unless skip-catalog mode)
        if (!skipCatalog) {
          catalog = mergeToCatalog(catalog, termData);
        }
      }

      // Track results
      const sectionCount = Object.values(termData.courses).reduce(
        (sum, c) => sum + c.sections.length,
        0
      );
      results.push({
        term: termData.termName,
        courses: Object.keys(termData.courses).length,
        sections: sectionCount,
      });
    }
  }

  // Save updated catalog (only if not dry-run and not skip-catalog)
  if (catalog && !dryRun && !skipCatalog) {
    saveCatalog(outputDir, catalog);
  }

  // Print summary
  console.log('\n' + '='.repeat(60));
  console.log('Summary');
  console.log('='.repeat(60));

  if (results.length === 0) {
    console.log('No data fetched.');
  } else {
    console.log('');
    console.log('Term             | Courses | Sections');
    console.log('─'.repeat(45));
    for (const r of results) {
      console.log(
        `${r.term.padEnd(16)} | ${r.courses.toString().padStart(7)} | ${r.sections.toString().padStart(8)}`
      );
    }
    console.log('─'.repeat(45));
    console.log(
      `${'Total'.padEnd(16)} | ${results
        .reduce((s, r) => s + r.courses, 0)
        .toString()
        .padStart(7)} | ${results
        .reduce((s, r) => s + r.sections, 0)
        .toString()
        .padStart(8)}`
    );

    if (!dryRun && catalog) {
      console.log('');
      console.log(`Catalog total courses: ${Object.keys(catalog.courses).length}`);
    }
  }

  if (dryRun) {
    console.log('\nDry-run complete. No files were written.');
  }

  console.log('='.repeat(60));
}

main().catch((error) => {
  console.error('Crawler failed:', error);
  process.exit(1);
});
