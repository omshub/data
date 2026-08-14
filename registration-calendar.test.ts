import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  academicYearsFor,
  normalizeRegistrationWindows,
  refreshRegistrationWindows,
} from './registration-calendar.js';

const fallAndSpringEvents = [
  {
    year: '2026', semester: '8', category: 'Registration',
    date: 'April 6 (Mon)', event: '<p>Schedule of Classes available online</p>',
  },
  {
    year: '2026', semester: '8', category: 'Registration',
    date: 'April 9 (Thu)', event: 'Time tickets for Fall 2026 Phase I registration post at 6:00 PM',
  },
  {
    year: '2026', semester: '8', category: 'Registration',
    date: 'April 13 (Mon) - May 22 (Fri)', event: 'Fall 2026 Phase I registration - Current students only',
  },
  {
    year: '2026', semester: '8', category: 'Registration',
    date: 'June 2 (Tue)', event: 'Time tickets for Fall 2026 registration post ( Continuing OMS Computer Science only )',
  },
  {
    year: '2026', semester: '8', category: 'Registration',
    date: 'June 9 (Tue) - July 2 (Thu)', event: 'Fall 2026 registration ( Continuing OMS Computer Science only )',
  },
  {
    year: '2026', semester: '8', category: 'Registration',
    date: 'August 13 (Thu)', event: 'Time tickets for Fall 2026 Phase II registration post at 6:00 PM',
  },
  {
    year: '2026', semester: '8', category: 'Registration',
    date: 'August 17 (Mon) - 28 (Fri)', event: 'Fall 2026 Phase II registration',
  },
  {
    year: '2026', semester: '2', category: 'Registration',
    date: 'October 14 (Wed)', event: 'Spring 2027 Schedule of Classes available online',
  },
  {
    year: '2026', semester: '2', category: 'Registration',
    date: 'October 29 (Thu)', event: 'Spring 2027 Phase I Time Tickets Post by 6:00 pm ET',
  },
  {
    year: '2026', semester: '2', category: 'Registration',
    date: 'November 2 (Mon) - December 11 (Fri)', event: 'Spring 2027 Phase I Registration',
  },
  {
    year: '2026', semester: '2', category: 'Registration',
    date: 'December 24 (Thu)', event: 'Time tickets for Spring 2027 Phase II registration post',
  },
  {
    year: '2027', semester: '2', category: 'Registration',
    date: 'January 4 (Mon) - 15 (Fri)', event: 'Spring 2027 Phase II Registration',
  },
];

describe('normalizeRegistrationWindows', () => {
  it('normalizes public and OMSCS-continuing registration windows', () => {
    assert.deepEqual(normalizeRegistrationWindows(fallAndSpringEvents), [
      {
        term: '202608', availability: '2026-04-06',
        phase1: { tickets: '2026-04-09', start: '2026-04-13', end: '2026-05-22' },
        continuingOmscs: { tickets: '2026-06-02', start: '2026-06-09', end: '2026-07-02' },
        phase2: { tickets: '2026-08-13', start: '2026-08-17', end: '2026-08-28' },
      },
      {
        term: '202702', availability: '2026-10-14',
        phase1: { tickets: '2026-10-29', start: '2026-11-02', end: '2026-12-11' },
        phase2: { tickets: '2026-12-24', start: '2027-01-04', end: '2027-01-15' },
      },
    ]);
  });

  it('ignores non-registration records and returns no term without a phase window', () => {
    assert.deepEqual(normalizeRegistrationWindows([
      { year: '2026', semester: '8', category: 'Grades', date: 'April 13', event: 'Fall 2026 Phase I registration' },
      { year: '2026', semester: '8', category: 'Registration', date: 'April 6', event: 'Fall 2026 Schedule of Classes available online' },
    ]), []);
  });

  it('rejects phase windows with impossible Gregorian dates', () => {
    assert.deepEqual(normalizeRegistrationWindows([
      {
        year: '2026', semester: '8', category: 'Registration',
        date: 'April 99 (Thu) - May 22 (Fri)', event: 'Fall 2026 Phase I registration',
      },
    ]), []);
  });

  it('rejects February 29 outside leap years', () => {
    assert.deepEqual(normalizeRegistrationWindows([
      {
        year: '2026', semester: '8', category: 'Registration',
        date: 'February 29 (Sun) - March 1 (Mon)', event: 'Fall 2026 Phase I registration',
      },
    ]), []);
  });

  it('accepts February 29 in leap years', () => {
    assert.deepEqual(normalizeRegistrationWindows([
      {
        year: '2024', semester: '8', category: 'Registration',
        date: 'February 29 (Thu) - March 1 (Fri)', event: 'Fall 2024 Phase I registration',
      },
    ]), [{ term: '202408', phase1: { start: '2024-02-29', end: '2024-03-01' } }]);
  });
});

describe('registration calendar importer', () => {
  it('fetches the current and next academic-year feeds with browser-like headers', async () => {
    const requests: Request[] = [];
    const directory = await mkdtemp(join(tmpdir(), 'registration-calendar-'));
    try {
      const result = await refreshRegistrationWindows({
        academicYears: ['2026-2027', '2027-2028'],
        outputPath: join(directory, 'registration-windows.json'),
        fetch: async (input, init) => {
          requests.push(new Request(input, init));
          return new Response(JSON.stringify({ data: fallAndSpringEvents }), { status: 200 });
        },
        now: new Date('2026-08-14T00:00:00Z'),
      });

      assert.deepEqual(requests.map((request) => request.url), [
        'https://registrar.gatech.edu/calevents/proxy?year=2026-2027&status=current',
        'https://registrar.gatech.edu/calevents/proxy?year=2027-2028&status=current',
      ]);
      assert.equal(requests[0].headers.get('accept'), 'application/json, text/plain, */*');
      assert.equal(requests[0].headers.get('referer'), 'https://registrar.gatech.edu/current-academic-calendar');
      assert.equal(requests[0].headers.get('origin'), 'https://registrar.gatech.edu');
      assert.equal(requests[0].headers.get('sec-fetch-mode'), 'cors');
      assert.match(requests[0].headers.get('user-agent') ?? '', /Chrome/);
      assert.equal(result.written, true);
      const document = JSON.parse(await readFile(join(directory, 'registration-windows.json'), 'utf8'));
      assert.equal(document.source, 'https://registrar.gatech.edu/calevents/proxy?year=<academic-year>&status=current');
      assert.deepEqual(document.terms, result.terms);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not overwrite output when neither feed has a valid phase window', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'registration-calendar-'));
    const outputPath = join(directory, 'registration-windows.json');
    try {
      const result = await refreshRegistrationWindows({
        academicYears: ['2026-2027', '2027-2028'], outputPath,
        fetch: async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
      });
      assert.equal(result.written, false);
      await assert.rejects(readFile(outputPath, 'utf8'));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not overwrite existing output for malformed phase records', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'registration-calendar-'));
    const outputPath = join(directory, 'registration-windows.json');
    const existingOutput = '{"preserve":"this"}\n';
    try {
      await writeFile(outputPath, existingOutput);
      const result = await refreshRegistrationWindows({
        academicYears: ['2026-2027'], outputPath,
        fetch: async () => new Response(JSON.stringify({ data: [{
          year: '2026', semester: '8', category: 'Registration',
          date: 'April 99 (Thu) - May 22 (Fri)', event: 'Fall 2026 Phase I registration',
        }] }), { status: 200 }),
      });
      assert.equal(result.written, false);
      assert.equal(await readFile(outputPath, 'utf8'), existingOutput);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('derives current and next academic years from the calendar date', () => {
    assert.deepEqual(academicYearsFor(new Date('2026-08-14T00:00:00Z')), ['2026-2027', '2027-2028']);
    assert.deepEqual(academicYearsFor(new Date('2027-01-15T00:00:00Z')), ['2026-2027', '2027-2028']);
  });
});
