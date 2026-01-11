/**
 * TypeScript interfaces for OSCAR crawler
 * Focused on seat counts and course catalog only
 */

// Banner 9 API response types
export interface BannerCourseResponse {
  success: boolean;
  totalCount: number;
  pageOffset: number;
  pageMaxSize: number;
  sectionsFetchedCount: number;
  data: BannerSection[];
}

export interface BannerSection {
  id: number;
  term: string;
  termDesc: string;
  courseReferenceNumber: string; // CRN
  courseNumber: string;
  subject: string;
  subjectDescription: string;
  sequenceNumber: string; // Section number
  courseTitle: string;
  creditHours: number | null;
  maximumEnrollment: number;
  enrollment: number;
  seatsAvailable: number;
  waitCapacity: number;
  waitCount: number;
  waitAvailable: number;
  openSection: boolean;
  faculty: BannerFaculty[];
  instructionalMethodDescription: string;
}

export interface BannerFaculty {
  displayName: string;
  primaryIndicator: boolean;
}

// Our normalized output types
export interface Section {
  crn: string;
  sectionNumber: string;
  instructor: string | null;
  enrolled: number;
  capacity: number;
  seatsAvailable: number;
  waitCount: number;
  waitCapacity: number;
}

export interface Course {
  courseId: string;
  subject: string;
  courseNumber: string;
  name: string;
  creditHours: number | null;
  sections: Section[];
  totalSeats: number;
  totalEnrolled: number;
  totalAvailable: number;
  totalWaitlisted: number;
}

export interface TermData {
  term: string;
  termName: string;
  lastUpdated: string;
  courses: Record<string, Course>;
}

export interface CatalogCourse {
  courseId: string;
  subject: string;
  courseNumber: string;
  name: string;
  creditHours: number | null;
  lastSeen: string;
}

export interface Catalog {
  lastUpdated: string;
  courses: Record<string, CatalogCourse>;
}
