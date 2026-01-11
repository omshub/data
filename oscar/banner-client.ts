/**
 * Banner 9 API client with session handling and rate limiting
 */

import { config } from './config.js';
import type { BannerCourseResponse } from './types.js';

interface CookieJar {
  cookies: Map<string, string>;
}

function parseCookies(setCookieHeaders: string[]): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const header of setCookieHeaders) {
    const parts = header.split(';')[0].split('=');
    if (parts.length >= 2) {
      const name = parts[0].trim();
      const value = parts.slice(1).join('=').trim();
      cookies.set(name, value);
    }
  }
  return cookies;
}

function cookiesToString(cookies: Map<string, string>): string {
  return Array.from(cookies.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class BannerClient {
  private cookieJar: CookieJar = { cookies: new Map() };
  private lastRequestTime = 0;

  /**
   * Initialize session by making a request to the base URL
   */
  async initSession(): Promise<void> {
    console.log('Initializing Banner session...');

    const response = await fetch(config.baseUrl, {
      method: 'GET',
      redirect: 'manual',
    });

    // Extract cookies from response
    const setCookieHeaders = response.headers.getSetCookie?.() || [];
    const cookies = parseCookies(setCookieHeaders);
    cookies.forEach((value, name) => this.cookieJar.cookies.set(name, value));

    console.log(`Session initialized with ${this.cookieJar.cookies.size} cookies`);
  }

  /**
   * Set the term for subsequent searches
   */
  async setTerm(termCode: string): Promise<void> {
    await this.rateLimit();
    console.log(`Setting term to ${termCode}...`);

    const response = await fetch(
      `${config.baseUrl}/ssb/term/search?mode=search`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Cookie: cookiesToString(this.cookieJar.cookies),
        },
        body: `term=${termCode}`,
      }
    );

    // Update cookies from response
    const setCookieHeaders = response.headers.getSetCookie?.() || [];
    const cookies = parseCookies(setCookieHeaders);
    cookies.forEach((value, name) => this.cookieJar.cookies.set(name, value));

    if (!response.ok) {
      throw new Error(`Failed to set term: ${response.status} ${response.statusText}`);
    }

    console.log(`Term set to ${termCode}`);
  }

  /**
   * Search for courses with pagination
   * Note: Banner API returns all courses when txt_subj is empty
   */
  async searchCourses(
    termCode: string,
    pageOffset = 0
  ): Promise<BannerCourseResponse> {
    await this.rateLimit();

    const params = new URLSearchParams({
      txt_term: termCode,
      txt_subj: '', // Empty = all subjects
      pageOffset: pageOffset.toString(),
      pageMaxSize: config.pageSize.toString(),
    });

    const url = `${config.baseUrl}/ssb/searchResults/searchResults?${params}`;
    console.log(`Fetching courses (offset ${pageOffset})...`);

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            Cookie: cookiesToString(this.cookieJar.cookies),
            Accept: 'application/json',
          },
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = (await response.json()) as BannerCourseResponse;

        if (!data.success) {
          throw new Error('Banner API returned success=false');
        }

        console.log(`  Found ${data.data?.length || 0} sections (total: ${data.totalCount})`);
        return data;
      } catch (error) {
        lastError = error as Error;
        console.error(`  Attempt ${attempt}/${config.maxRetries} failed: ${lastError.message}`);

        if (attempt < config.maxRetries) {
          const backoff = config.retryBackoffMs * Math.pow(2, attempt - 1);
          console.log(`  Retrying in ${backoff}ms...`);
          await sleep(backoff);
        }
      }
    }

    throw new Error(`Failed after ${config.maxRetries} attempts: ${lastError?.message}`);
  }

  /**
   * Fetch all courses for a term (handles pagination)
   */
  async fetchAllCourses(termCode: string): Promise<BannerCourseResponse['data']> {
    const allSections: BannerCourseResponse['data'] = [];
    let pageOffset = 0;
    let totalCount = 0;

    do {
      const response = await this.searchCourses(termCode, pageOffset);
      allSections.push(...(response.data || []));
      totalCount = response.totalCount;
      pageOffset += config.pageSize;
    } while (pageOffset < totalCount);

    return allSections;
  }

  /**
   * Rate limiting to avoid overwhelming the server
   */
  private async rateLimit(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;

    if (elapsed < config.requestDelayMs) {
      await sleep(config.requestDelayMs - elapsed);
    }

    this.lastRequestTime = Date.now();
  }
}
