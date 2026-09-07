import type { MediaMetadata } from '../domain/media.js';
import type { MatchCandidate, MatchDecision } from './match-types.js';
import {
  candidateYear,
  clampScore,
  hasUnwantedContent,
  matchCandidateTitle,
} from './matching-rules.js';

const minimumMovieScore = 60;

export function matchMovie(metadata: MediaMetadata, candidate: MatchCandidate): MatchDecision {
  if (metadata.type !== 'movie' || candidate.mediaType !== 'movie') {
    return { matched: false, score: 0, reasons: ['media type mismatch'] };
  }
  if (hasUnwantedContent(candidate)) {
    return { matched: false, score: 0, reasons: ['non-feature content'] };
  }

  const titleMatch = matchCandidateTitle(metadata, candidate);
  if (!titleMatch.matched) {
    return { matched: false, score: 0, reasons: ['title mismatch'] };
  }

  let score = titleMatch.score;
  const reasons = titleMatch.reason === undefined ? [] : [titleMatch.reason];
  const year = candidateYear(candidate, titleYears(metadata));

  if (metadata.year !== undefined && year !== undefined) {
    if (metadata.year === year) {
      score += 20;
      reasons.push('year match');
    } else {
      score -= 40;
      reasons.push('year mismatch');
    }
  }

  const finalScore = clampScore(score);
  return { matched: finalScore >= minimumMovieScore, score: finalScore, reasons };
}

function titleYears(metadata: MediaMetadata): ReadonlySet<number> {
  const titles = [
    metadata.originalTitle,
    metadata.englishTitle,
    metadata.czechTitle,
    metadata.slovakTitle,
    ...metadata.alternativeTitles,
  ];
  return new Set(
    titles.flatMap((title) =>
      title === undefined
        ? []
        : [...title.matchAll(/\b(?:19|20)\d{2}\b/gu)].map((match) => Number(match[0])),
    ),
  );
}
