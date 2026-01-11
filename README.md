# OMSHub Data

Repository that scrapes and stores OMSCS related data.

## Course Availability Crawler

Fetches real-time course registration and seat availability data from Georgia Tech's Banner 9 system (OSCAR).

### Automated Scraping

The GitHub Actions workflow runs automatically every 30 minutes and commits data directly to the `data/` folder.

To trigger manually:
1. Go to Actions > "Crawl Course Availability"
2. Click "Run workflow"
3. Select mode:
   - `current` - Current + upcoming terms (default)
   - `all` - All terms back to 2014
   - `specific` - Specify a term code (e.g., `202502` for Spring 2025)

### Local Usage

```bash
# Install dependencies
npm install -g tsx

# Fetch current term
npx tsx oscar/crawler.ts

# Fetch specific term
npx tsx oscar/crawler.ts --term 202502

# Fetch all terms (back to 2014)
npx tsx oscar/crawler.ts --all

# Dry run (fetch and display without saving)
npx tsx oscar/crawler.ts --dry-run

# Custom output directory
npx tsx oscar/crawler.ts --output /path/to/output
```

### Output

The crawler generates JSON files in `data/`:
- `{termCode}.json` - Course availability data for each term (e.g., `202502.json`)
- `catalog.json` - Aggregated course catalog across all terms

### Term Codes

Format: `YYYYMM` where MM is:
- `02` = Spring
- `05` = Summer
- `08` = Fall

Example: `202502` = Spring 2025

---

## OMSCS Catalog Crawler

Fetches course offerings and specialization data from the official OMSCS website (omscs.gatech.edu).

### Automated Scraping

The GitHub Actions workflow runs weekly on Mondays at 9am UTC. When changes are detected, it creates a Pull Request for review (instead of committing directly) so new course offerings can be verified before merging.

To trigger manually:
1. Go to Actions > "Crawl OMSCS Catalog"
2. Click "Run workflow"

### Local Usage

```bash
# Install dependencies
npm install -g tsx

# Crawl courses and specializations
npx tsx catalog/crawler.ts

# Dry run (fetch and display without saving)
npx tsx catalog/crawler.ts --dry-run
```

### Output

The crawler generates JSON files in `static/`:
- `courses.json` - All OMSCS courses with metadata (name, department, foundational status, etc.)
- `specializations.json` - All specializations with core courses and electives

---

## Static Reference Data

The `static/` directory contains reference data used by the OMSHub application:

| File | Description |
|------|-------------|
| `courses.json` | OMSCS courses with metadata (name, department, foundational status, URLs) |
| `specializations.json` | Specializations with core course groups and electives |
| `departments.json` | Georgia Tech departments (CS, CSE, ECE, ISYE, etc.) |
| `programs.json` | Online master's programs (OMSCS, OMSA, OMSCYBER) |
| `semesters.json` | Semester definitions (Spring, Summer, Fall) |
| `grades.json` | Grade options (A through F, W, prefer not to say) |
| `education-levels.json` | Education levels (Bachelor, Master, PhD) |
| `subject-areas.json` | Undergraduate subject areas for user profiles |
