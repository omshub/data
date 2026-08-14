/**
 * Imports Georgia Tech Registrar calendar registration dates into a small,
 * date-only data set. Source dates are calendar dates, not timestamps.
 */

export interface CalendarEvent {
  year: string;
  semester: string;
  category: string;
  date: string;
  event: string;
}

export interface RegistrationPhase {
  tickets?: string;
  start?: string;
  end?: string;
}

export interface RegistrationWindow {
  term: string;
  availability?: string;
  phase1?: RegistrationPhase;
  continuingOmscs?: RegistrationPhase;
  phase2?: RegistrationPhase;
}

import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REGISTRAR_CALENDAR_URL = 'https://registrar.gatech.edu/calevents/proxy?year=<academic-year>&status=current';

function registrarCalendarUrl(academicYear: string): string {
  return REGISTRAR_CALENDAR_URL.replace('<academic-year>', encodeURIComponent(academicYear));
}

const REGISTRAR_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  Referer: 'https://registrar.gatech.edu/current-academic-calendar',
  Origin: 'https://registrar.gatech.edu',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

function text(value: string): string {
  return value.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
}

function termCode(event: string): string | undefined {
  const match = text(event).match(/\b(Spring|Summer|Fall)\s+(20\d{2})\b/i);
  if (!match) return undefined;
  const suffix = match[1].toLowerCase() === 'spring' ? '02' : match[1].toLowerCase() === 'summer' ? '05' : '08';
  return `${match[2]}${suffix}`;
}

function parsedDate(part: string, calendarYear: number): { value: string; month: number } | undefined {
  const match = part.trim().match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})/i);
  if (!match) return undefined;
  const month = MONTHS[match[1].toLowerCase()];
  return { value: `${calendarYear}-${String(month).padStart(2, '0')}-${match[2].padStart(2, '0')}`, month };
}

function eventDates(date: string, calendarYear: string): { start?: string; end?: string } {
  const [startPart, endPart] = date.split(/\s+-\s+/, 2);
  const start = parsedDate(startPart, Number(calendarYear));
  if (!start) return {};
  if (!endPart) return { start: start.value };
  const endWithMonth = parsedDate(endPart, Number(calendarYear));
  const end = endWithMonth ?? parsedDate(`${startPart.match(/[A-Za-z]+/)?.[0] ?? ''} ${endPart}`, Number(calendarYear));
  if (!end) return { start: start.value };
  const endYear = end.month < start.month ? Number(calendarYear) + 1 : Number(calendarYear);
  return { start: start.value, end: end.value.replace(/^\d{4}/, String(endYear)) };
}

function phase(window: RegistrationWindow, key: 'phase1' | 'phase2' | 'continuingOmscs'): RegistrationPhase {
  return window[key] ?? (window[key] = {});
}

/** Normalizes records from both Registrar academic-calendar feeds. */
export function normalizeRegistrationWindows(events: CalendarEvent[]): RegistrationWindow[] {
  const windows = new Map<string, RegistrationWindow>();
  for (const record of events) {
    if (record.category.toLowerCase() !== 'registration') continue;
    const event = text(record.event);
    const availability = /schedule of classes available online/i.test(event);
    const semesterSuffix = record.semester === '2' ? '02' : record.semester === '5F' ? '05' : record.semester === '8' ? '08' : undefined;
    const term = termCode(event) ?? (availability && semesterSuffix ? `${record.year}${semesterSuffix}` : undefined);
    if (!term) continue;
    const dates = eventDates(record.date, record.year);
    const window = windows.get(term) ?? { term };
    windows.set(term, window);
    const continuing = /continuing\s+oms\s+computer\s+science/i.test(event);
    const ticket = /time\s*tickets?/i.test(event);
    const phaseMatch = event.match(/phase\s+(i|ii)\b/i);

    if (availability) window.availability = dates.start;
    if (continuing) {
      const target = phase(window, 'continuingOmscs');
      if (ticket) target.tickets = dates.start;
      else if (/registration/i.test(event) && dates.end) Object.assign(target, dates);
    } else if (phaseMatch) {
      const target = phase(window, phaseMatch[1].toLowerCase() === 'i' ? 'phase1' : 'phase2');
      if (ticket) target.tickets = dates.start;
      else if (/registration/i.test(event) && dates.end) Object.assign(target, dates);
    }
  }
  return [...windows.values()]
    .filter((window) => window.phase1?.start || window.phase2?.start || window.continuingOmscs?.start)
    .sort((a, b) => a.term.localeCompare(b.term));
}

export function academicYearsFor(now = new Date()): [string, string] {
  const year = now.getUTCFullYear();
  const startYear = now.getUTCMonth() >= 6 ? year : year - 1;
  return [`${startYear}-${startYear + 1}`, `${startYear + 1}-${startYear + 2}`];
}

interface RegistrarResponse { data?: CalendarEvent[]; }

export interface RefreshOptions {
  academicYears?: string[];
  outputPath?: string;
  fetch?: typeof globalThis.fetch;
  now?: Date;
}

export interface RefreshResult {
  written: boolean;
  terms: RegistrationWindow[];
}

/** Fetches and atomically writes validated registration windows. */
export async function refreshRegistrationWindows(options: RefreshOptions = {}): Promise<RefreshResult> {
  const fetcher = options.fetch ?? globalThis.fetch;
  const academicYears = options.academicYears ?? academicYearsFor(options.now);
  const responses = await Promise.all(academicYears.map(async (academicYear) => {
    const response = await fetcher(registrarCalendarUrl(academicYear), {
      headers: REGISTRAR_HEADERS,
    });
    if (!response.ok) throw new Error(`Registrar calendar request failed for ${academicYear}: ${response.status}`);
    const body = await response.json() as RegistrarResponse;
    if (!Array.isArray(body.data)) throw new Error(`Registrar calendar response for ${academicYear} has no data array`);
    return body.data;
  }));
  const terms = normalizeRegistrationWindows(responses.flat());
  if (terms.length === 0) return { written: false, terms };

  const outputPath = options.outputPath ?? resolve(dirname(fileURLToPath(import.meta.url)), 'static/registration-windows.json');
  const document = {
    schemaVersion: 1,
    source: REGISTRAR_CALENDAR_URL,
    generatedAt: (options.now ?? new Date()).toISOString(),
    terms,
  };
  await mkdir(dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`);
  await rename(temporaryPath, outputPath);
  return { written: true, terms };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  refreshRegistrationWindows().then((result) => {
    if (!result.written) throw new Error('No valid registration phase windows parsed; existing output was not replaced');
    console.log(`Wrote ${result.terms.length} registration term windows`);
  }).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
