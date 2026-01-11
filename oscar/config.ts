/**
 * Configuration for OSCAR crawler
 */

export const config = {
  // Banner 9 API base URL
  baseUrl: 'https://registration.banner.gatech.edu/StudentRegistrationSsb',

  // Subjects to crawl (OMSCS-relevant)
  // CS/CSE: Core computer science courses
  // ECE: Electrical and Computer Engineering (e.g., ECE 8843)
  // ISYE: Industrial and Systems Engineering (analytics courses)
  // MGT: Management (e.g., MGT 6311, MGT 8813)
  // PUBP: Public Policy (e.g., PUBP 6725, PUBP 8823)
  // INTA: International Affairs (e.g., INTA 6450)
  subjects: ['CS', 'CSE', 'ECE', 'ISYE', 'MGT', 'PUBP', 'INTA'],

  // Rate limiting
  requestDelayMs: 1000, // 1 second between requests
  maxRetries: 3,
  retryBackoffMs: 2000, // Base backoff, exponentially increases

  // Pagination
  pageSize: 500, // Max supported is 500

  // Earliest year to fetch terms from (OMSCS started ~2014)
  earliestYear: 2014,

  // Term codes format: YYYYMM where MM is:
  // 02 = Spring, 05 = Summer, 08 = Fall
  // Example: 202502 = Spring 2025
  getCurrentTermCode: (): string => {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;

    // Determine current term based on month
    if (month >= 1 && month <= 4) {
      // Spring term
      return `${year}02`;
    } else if (month >= 5 && month <= 7) {
      // Summer term
      return `${year}05`;
    } else {
      // Fall term
      return `${year}08`;
    }
  },

  // Get upcoming/next term code (for registration)
  getUpcomingTermCode: (): string => {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;

    // Return the next term after current
    if (month >= 1 && month <= 4) {
      // Currently Spring -> Summer is upcoming
      return `${year}05`;
    } else if (month >= 5 && month <= 7) {
      // Currently Summer -> Fall is upcoming
      return `${year}08`;
    } else {
      // Currently Fall -> Spring next year is upcoming
      return `${year + 1}02`;
    }
  },

  // Get previous term code
  getPreviousTermCode: (termCode: string): string => {
    const year = parseInt(termCode.substring(0, 4), 10);
    const semester = termCode.substring(4);

    switch (semester) {
      case '02': // Spring -> previous Fall
        return `${year - 1}08`;
      case '05': // Summer -> previous Spring
        return `${year}02`;
      case '08': // Fall -> previous Summer
        return `${year}05`;
      default:
        return termCode;
    }
  },

  // Get ALL terms from current back to earliest year
  getAllTerms: (): string[] => {
    const terms: string[] = [];
    const now = new Date();
    const currentYear = now.getFullYear();
    const month = now.getMonth() + 1;

    // Determine current semester
    let currentSemester: string;
    if (month >= 1 && month <= 4) {
      currentSemester = '02';
    } else if (month >= 5 && month <= 7) {
      currentSemester = '05';
    } else {
      currentSemester = '08';
    }

    // Generate all terms from current back to earliest year
    for (let year = currentYear; year >= config.earliestYear; year--) {
      const semesters = year === currentYear
        ? ['08', '05', '02'].filter((s) => s <= currentSemester)
        : ['08', '05', '02'];

      for (const sem of semesters) {
        terms.push(`${year}${sem}`);
      }
    }

    return terms;
  },

  getTermName: (termCode: string): string => {
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
        return `Unknown ${year}`;
    }
  },

  // Output paths
  outputDir: 'data',
  getTermFilename: (termCode: string): string => `${termCode}.json`,
  catalogFilename: 'catalog.json',
};
