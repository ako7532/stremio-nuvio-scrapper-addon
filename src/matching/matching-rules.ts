import type { MediaMetadata } from '../domain/media.js';
import { normalizeTitle } from '../metadata/title-normalizer.js';
import type { MatchCandidate } from './match-types.js';

const releaseMetadataToken =
  /^(?:19\d{2}|20\d{2}|s\d{1,2}(?:(?:e|-e?)\d{1,3})*|season\s+\d{1,2}|seasons?\s+\d{1,2}\s+\d{1,2}|serie\s+\d{1,2}(?:\s+\d{1,2})?|\d{1,2}(?:\s+\d{1,2})?\s+serie|\d{1,2}x\d{1,3}|2160p?|1440p?|1080p?|720p?|576p?|480p?|4k|uhd|remux|blu\s*ray|b[dr]rip|web\s*dl|web\s*rip|hdtv|dvd|hevc|h\s*265|x265|avc|h\s*264|x264|av1)(?:\s|$)/u;
const unwantedContentPattern = /\b(?:sample|trailer|soundtrack|featurette|extras?)\b/iu;
const subtitleFilePattern = /\.(?:srt|sub|ass|ssa|vtt)(?:\s|$)/iu;

export type TitleMatch = {
  matched: boolean;
  score: number;
  reason?: string;
};

export function matchCandidateTitle(
  metadata: MediaMetadata,
  candidate: MatchCandidate,
): TitleMatch {
  const expectedTitles = uniqueExpectedTitles(metadata);
  const candidateTitle = normalizeTitle(candidate.title);
  const releaseNames = [candidate.releaseName, candidate.filename].filter(
    (value): value is string => value !== undefined,
  );

  if (expectedTitles.includes(candidateTitle)) {
    const hasConflictingSuffix = releaseNames.some((releaseName) =>
      expectedTitles.some((expectedTitle) =>
        hasUnrecognizedTitleSuffix(releaseName, expectedTitle),
      ),
    );
    if (hasConflictingSuffix) {
      return { matched: false, score: 0 };
    }
    return { matched: true, score: 70, reason: 'exact provider title' };
  }

  if (
    releaseNames.some((releaseName) =>
      expectedTitles.some((expectedTitle) => releaseStartsWithTitle(releaseName, expectedTitle)),
    ) ||
    releaseNames.some((releaseName) => releaseStartsWithCombinedTitles(releaseName, expectedTitles))
  ) {
    return { matched: true, score: 60, reason: 'exact release title' };
  }

  return { matched: false, score: 0 };
}

export function hasUnwantedContent(candidate: MatchCandidate): boolean {
  const value = `${candidate.releaseName} ${candidate.filename ?? ''}`;
  return unwantedContentPattern.test(value) || subtitleFilePattern.test(value);
}

export function candidateYear(
  candidate: MatchCandidate,
  ignoredYears: ReadonlySet<number> = new Set(),
): number | undefined {
  if (candidate.year !== undefined) {
    return candidate.year;
  }

  for (const value of [candidate.title, candidate.releaseName, candidate.filename]) {
    if (value === undefined) continue;
    for (const match of value.matchAll(/\b(?:19|20)\d{2}\b/gu)) {
      const year = Number(match[0]);
      if (!ignoredYears.has(year)) return year;
    }
  }
  return undefined;
}

export function clampScore(score: number): number {
  return Math.max(0, Math.min(100, score));
}

function uniqueExpectedTitles(metadata: MediaMetadata): readonly string[] {
  return [
    metadata.originalTitle,
    metadata.englishTitle,
    metadata.czechTitle,
    metadata.slovakTitle,
    ...metadata.alternativeTitles,
  ]
    .filter((value): value is string => value !== undefined)
    .flatMap(titleMatchVariants)
    .filter((value, index, values) => value !== '' && values.indexOf(value) === index);
}

function titleMatchVariants(value: string): readonly string[] {
  const normalized = normalizeTitle(value);
  const variants = [normalized];
  if (/[’']/u.test(value)) variants.push(normalizeTitle(value.replace(/[’']/gu, ' ')));
  const compactNumber = normalized.replace(/([\p{L}\p{M}]{3,}) ((?:19|20)\d{2})$/u, '$1$2');
  if (compactNumber !== normalized) variants.push(compactNumber);
  return variants;
}

function releaseStartsWithTitle(releaseName: string, expectedTitle: string): boolean {
  const normalizedRelease = normalizeTitle(stripExtension(releaseName));
  if (normalizedRelease === expectedTitle) {
    return true;
  }
  if (!normalizedRelease.startsWith(`${expectedTitle} `)) {
    return false;
  }

  return releaseMetadataToken.test(normalizedRelease.slice(expectedTitle.length + 1));
}

function releaseStartsWithCombinedTitles(
  releaseName: string,
  expectedTitles: readonly string[],
): boolean {
  const parts = stripExtension(releaseName).split(/\s*\/\s*/u);
  if (parts.length < 2 || !expectedTitles.includes(normalizeTitle(parts[0] ?? ''))) {
    return false;
  }
  return parts
    .slice(1)
    .some((part) =>
      expectedTitles.some((expectedTitle) => releaseStartsWithTitle(part, expectedTitle)),
    );
}

function hasUnrecognizedTitleSuffix(releaseName: string, expectedTitle: string): boolean {
  const normalizedRelease = normalizeTitle(stripExtension(releaseName));
  return (
    normalizedRelease.startsWith(`${expectedTitle} `) &&
    !releaseMetadataToken.test(normalizedRelease.slice(expectedTitle.length + 1))
  );
}

function stripExtension(value: string): string {
  return value.replace(/\.[A-Za-z0-9]{2,4}$/u, '');
}
