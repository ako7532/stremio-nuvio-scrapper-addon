import * as cheerio from 'cheerio';

import {
  absoluteSktorrentUrl,
  assertSktorrentPage,
  normalizeWhitespace,
  parseFlagLanguage,
  parseNonNegativeInteger,
  parseSizeBytes,
} from './sktorrent-parser-utils.js';
import type { SktorrentListingResult } from './sktorrent-types.js';
import { SktorrentParserError } from './sktorrent-types.js';

const DETAILS_ID_PATTERN = /(?:^|[?&])id=([a-f\d]{40})(?:&|$)/iu;
const LISTING_STATS_PATTERN =
  /Velkost\s+([^|]+)\|\s*Pridany\s+(\d{2}\/\d{2}\/\d{4})\s+Odosielaju\s*:\s*(\d+)\s+Stahuju\s*:\s*(\d+)/iu;

export const parseSktorrentListing = (html: string): readonly SktorrentListingResult[] => {
  const $ = cheerio.load(html);
  assertSktorrentPage($, 'listing');

  const results: SktorrentListingResult[] = [];
  $('a[href*="details.php"][href*="id="]').each((_index, link) => {
    const href = $(link).attr('href');
    const id = href === undefined ? undefined : DETAILS_ID_PATTERN.exec(href)?.[1]?.toLowerCase();
    if (href === undefined || id === undefined) {
      return;
    }

    const card = $(link).closest('div');
    const stats = LISTING_STATS_PATTERN.exec(normalizeWhitespace(card.text()));
    const category = normalizeWhitespace(card.find('a[href*="category="]').first().text());
    const title = normalizeWhitespace($(link).text());

    if (stats === null || category.length === 0 || title.length === 0) {
      throw new SktorrentParserError(`SKTorrent listing card ${id} is missing required fields`);
    }

    results.push({
      id,
      title,
      category,
      language: parseFlagLanguage(card.find('img[src*="/flag/"]').first().attr('src')),
      sizeBytes: parseSizeBytes(stats[1] ?? '', 'listing size'),
      addedDate: toIsoDate(stats[2] ?? ''),
      seeders: parseNonNegativeInteger(stats[3] ?? '', 'listing seeders'),
      leechers: parseNonNegativeInteger(stats[4] ?? '', 'listing leechers'),
      detailUrl: absoluteSktorrentUrl(href),
    });
  });

  if (results.length === 0) {
    const noResults = $('a[href="index.php"]').filter((_index, link) =>
      normalizeWhitespace($(link).text()).startsWith('Nenasli ste co ste hladali'),
    );
    if (noResults.length > 0) {
      return [];
    }
    throw new SktorrentParserError('SKTorrent listing contains no recognizable result cards');
  }

  return results;
};

const toIsoDate = (value: string): string => {
  const [day, month, year] = value.split('/');
  if (day === undefined || month === undefined || year === undefined) {
    throw new SktorrentParserError(`Invalid listing date: ${value}`);
  }
  return `${year}-${month}-${day}`;
};
