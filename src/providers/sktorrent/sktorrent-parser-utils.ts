import type { CheerioAPI } from 'cheerio';

import type { SktorrentLanguage } from './sktorrent-types.js';
import { SktorrentParserError } from './sktorrent-types.js';

const SIZE_UNITS: Readonly<Record<string, number>> = {
  B: 1,
  KB: 1_000,
  MB: 1_000_000,
  GB: 1_000_000_000,
  TB: 1_000_000_000_000,
  KIB: 1_024,
  MIB: 1_048_576,
  GIB: 1_073_741_824,
  TIB: 1_099_511_627_776,
};

const LANGUAGE_BY_FLAG: Readonly<Record<string, SktorrentLanguage>> = {
  cz: 'cs',
  cs: 'cs',
  sk: 'sk',
  eng: 'en',
  en: 'en',
  de: 'de',
  hu: 'hu',
  pl: 'pl',
};

export const normalizeWhitespace = (value: string): string => value.replace(/\s+/gu, ' ').trim();

export const parseSizeBytes = (value: string, context: string): number => {
  const match = /^(\d+(?:[.,]\d+)?)\s*([KMGT]?i?B)$/iu.exec(normalizeWhitespace(value));
  if (match === null) {
    throw new SktorrentParserError(`Invalid ${context}: ${value}`);
  }

  const amount = Number.parseFloat((match[1] ?? '').replace(',', '.'));
  const multiplier = SIZE_UNITS[(match[2] ?? '').toUpperCase()];
  if (!Number.isFinite(amount) || multiplier === undefined) {
    throw new SktorrentParserError(`Invalid ${context}: ${value}`);
  }

  return Math.round(amount * multiplier);
};

export const parseNonNegativeInteger = (value: string, context: string): number => {
  const parsed = Number.parseInt(value, 10);
  if (!/^\d+$/u.test(value.trim()) || !Number.isSafeInteger(parsed)) {
    throw new SktorrentParserError(`Invalid ${context}: ${value}`);
  }
  return parsed;
};

export const parseFlagLanguage = (source: string | undefined): SktorrentLanguage => {
  const match = source === undefined ? null : /\/flag\/([a-z]+)\.png(?:\?.*)?$/iu.exec(source);
  return LANGUAGE_BY_FLAG[match?.[1]?.toLowerCase() ?? ''] ?? 'unknown';
};

export const absoluteSktorrentUrl = (path: string): string => {
  const url = new URL(path, 'https://sktorrent.eu/torrent/');
  if (url.origin !== 'https://sktorrent.eu' || !url.pathname.startsWith('/torrent/')) {
    throw new SktorrentParserError(`Unexpected SKTorrent URL: ${path}`);
  }
  return url.toString();
};

export const assertSktorrentPage = ($: CheerioAPI, pageKind: string): void => {
  if ($('html').attr('lang') !== 'sk' || $('table.lista').length === 0) {
    throw new SktorrentParserError(`SKTorrent ${pageKind} page structure is not recognized`);
  }
};
