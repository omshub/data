import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mergeToCatalog, parseSectionsToCourses } from './parser.js';
import type { BannerSection, Catalog, TermData } from './types.js';

function bannerSection(
  overrides: Partial<BannerSection>
): BannerSection {
  return {
    id: 1,
    term: '202605',
    termDesc: 'Summer 2026',
    courseReferenceNumber: '10001',
    courseNumber: '6311',
    subject: 'MGT',
    subjectDescription: 'Management',
    sequenceNumber: 'O01',
    courseTitle: 'Digital Marketing',
    creditHours: 3,
    maximumEnrollment: 100,
    enrollment: 50,
    seatsAvailable: 50,
    waitCapacity: 0,
    waitCount: 0,
    waitAvailable: 0,
    openSection: true,
    faculty: [],
    instructionalMethodDescription: 'Online',
    ...overrides,
  };
}

describe('parseSectionsToCourses', () => {
  it('uses catalog course IDs for known management special topics', () => {
    const courses = parseSectionsToCourses([
      bannerSection({
        courseNumber: '8813',
        subject: 'MGT',
        subjectDescription: 'Management',
        sequenceNumber: 'O01',
        courseTitle: 'Special Topics',
      }),
    ]);

    assert.ok(courses['MGT-8813']);
    assert.equal(courses['MGT-8813'].courseNumber, '8813');
    assert.equal(courses['MGT-8813'].name, 'Financial Modeling');
    assert.equal(courses['MGT-8813'].sections[0].sectionNumber, 'O01');
    assert.equal(courses['MGT-8813-O01'], undefined);
  });

  it('groups multiple online sections under a known catalog course ID', () => {
    const courses = parseSectionsToCourses([
      bannerSection({
        courseReferenceNumber: '10001',
        courseNumber: '8813',
        subject: 'MGT',
        sequenceNumber: 'O01',
        courseTitle: 'Special Topics',
      }),
      bannerSection({
        courseReferenceNumber: '10002',
        courseNumber: '8813',
        subject: 'MGT',
        sequenceNumber: 'O02',
        courseTitle: 'Special Topics',
      }),
    ]);

    assert.deepEqual(
      courses['MGT-8813'].sections.map((section) => section.sectionNumber),
      ['O01', 'O02']
    );
    assert.equal(courses['MGT-8813'].totalSeats, 200);
    assert.equal(courses['MGT-8813-O01'], undefined);
    assert.equal(courses['MGT-8813-O02'], undefined);
  });

  it('keeps section-specific IDs for known catalog special topics', () => {
    const courses = parseSectionsToCourses([
      bannerSection({
        courseNumber: '8803',
        subject: 'CS',
        subjectDescription: 'Computer Science',
        sequenceNumber: 'O31',
        courseTitle: 'Cybersecurity of Drones',
      }),
    ]);

    assert.ok(courses['CS-8803-O31']);
    assert.equal(courses['CS-8803-O31'].courseNumber, '8803-O31');
    assert.equal(courses['CS-8803-O31'].name, 'Cybersecurity of Drones');
    assert.equal(courses['CS-8803'], undefined);
  });

  it('falls back to section-specific IDs for unknown special topics', () => {
    const courses = parseSectionsToCourses([
      bannerSection({
        courseNumber: '8803',
        subject: 'CS',
        subjectDescription: 'Computer Science',
        sequenceNumber: 'O99',
        courseTitle: 'Experimental Special Topic',
      }),
    ]);

    assert.ok(courses['CS-8803-O99']);
    assert.equal(courses['CS-8803-O99'].name, 'Experimental Special Topic');
  });
});

describe('mergeToCatalog', () => {
  it('removes stale section-specific catalog IDs when a canonical base course is seen', () => {
    const existingCatalog: Catalog = {
      lastUpdated: '2026-05-18T00:00:00.000Z',
      courses: {
        'MGT-8813-O01': {
          courseId: 'MGT-8813-O01',
          subject: 'MGT',
          courseNumber: '8813-O01',
          name: 'Special Topics',
          creditHours: 3,
          lastSeen: '202608',
        },
      },
    };
    const termData: TermData = {
      term: '202608',
      termName: 'Fall 2026',
      lastUpdated: '2026-05-19T00:00:00.000Z',
      courses: {
        'MGT-8813': {
          courseId: 'MGT-8813',
          subject: 'MGT',
          courseNumber: '8813',
          name: 'Financial Modeling',
          creditHours: 3,
          sections: [],
          totalSeats: 0,
          totalEnrolled: 0,
          totalAvailable: 0,
          totalWaitlisted: 0,
        },
      },
    };

    const catalog = mergeToCatalog(existingCatalog, termData);

    assert.equal(catalog.courses['MGT-8813-O01'], undefined);
    assert.equal(catalog.courses['MGT-8813'].name, 'Financial Modeling');
  });

  it('keeps section-specific catalog IDs when the static catalog uses them', () => {
    const existingCatalog: Catalog = {
      lastUpdated: '2026-05-18T00:00:00.000Z',
      courses: {},
    };
    const termData: TermData = {
      term: '202605',
      termName: 'Summer 2026',
      lastUpdated: '2026-05-19T00:00:00.000Z',
      courses: {
        'CS-8803-O31': {
          courseId: 'CS-8803-O31',
          subject: 'CS',
          courseNumber: '8803-O31',
          name: 'Cybersecurity of Drones',
          creditHours: 3,
          sections: [],
          totalSeats: 0,
          totalEnrolled: 0,
          totalAvailable: 0,
          totalWaitlisted: 0,
        },
      },
    };

    const catalog = mergeToCatalog(existingCatalog, termData);

    assert.equal(
      catalog.courses['CS-8803-O31'].name,
      'Cybersecurity of Drones'
    );
  });
});
