#!/usr/bin/env npx tsx
/**
 * Merge Catalog - Combines term JSON files into a unified catalog.json
 * Used by GitHub Actions after parallel crawl jobs complete
 *
 * Usage:
 *   npx tsx oscar/merge-catalog.ts --input data    # Merge all term files in data/
 */

import * as fs from 'fs';
import * as path from 'path';
import { mergeToCatalog } from './parser.js';
import type { Catalog, TermData } from './types.js';
import { config } from './config.js';

interface MergeArgs {
  inputDir: string;
}

function parseArgs(): MergeArgs {
  const args = process.argv.slice(2);
  let inputDir = config.outputDir;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input' && args[i + 1]) {
      inputDir = args[i + 1];
      i++;
    }
  }

  return { inputDir };
}

function findTermFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }

  const files = fs.readdirSync(dir);
  // Match term files like 202502.json, 202408.json, etc.
  const termFilePattern = /^\d{6}\.json$/;

  return files
    .filter((f) => termFilePattern.test(f))
    .map((f) => path.join(dir, f))
    .sort(); // Sort chronologically
}

function loadTermData(filepath: string): TermData | null {
  try {
    const content = fs.readFileSync(filepath, 'utf-8');
    return JSON.parse(content) as TermData;
  } catch (error) {
    console.warn(`Failed to load ${filepath}: ${(error as Error).message}`);
    return null;
  }
}

function loadExistingCatalog(dir: string): Catalog | null {
  const catalogPath = path.join(dir, config.catalogFilename);
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

function saveCatalog(dir: string, catalog: Catalog): void {
  const filepath = path.join(dir, config.catalogFilename);
  fs.writeFileSync(filepath, JSON.stringify(catalog, null, 2));
  console.log(`Saved catalog to ${filepath}`);
}

async function main(): Promise<void> {
  const { inputDir } = parseArgs();

  console.log('='.repeat(60));
  console.log('Merge Catalog');
  console.log('='.repeat(60));
  console.log(`Input directory: ${inputDir}`);

  // Find all term files
  const termFiles = findTermFiles(inputDir);

  if (termFiles.length === 0) {
    console.log('No term files found to merge.');
    return;
  }

  console.log(`Found ${termFiles.length} term file(s) to merge`);

  // Load existing catalog
  let catalog = loadExistingCatalog(inputDir);

  // Merge each term file
  let mergedCount = 0;
  for (const termFile of termFiles) {
    const termData = loadTermData(termFile);
    if (termData) {
      console.log(`  Merging: ${termData.termName} (${Object.keys(termData.courses).length} courses)`);
      catalog = mergeToCatalog(catalog, termData);
      mergedCount++;
    }
  }

  // Save the merged catalog
  if (catalog && mergedCount > 0) {
    saveCatalog(inputDir, catalog);
    console.log(`\nMerged ${mergedCount} term(s) into catalog`);
    console.log(`Catalog total courses: ${Object.keys(catalog.courses).length}`);
  }

  console.log('='.repeat(60));
}

main().catch((error) => {
  console.error('Merge failed:', error);
  process.exit(1);
});
