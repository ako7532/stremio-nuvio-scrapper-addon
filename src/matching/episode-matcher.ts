import type { MediaMetadata } from '../domain/media.js';
import type { MatchCandidate, MatchDecision } from './match-types.js';
import { clampScore, hasUnwantedContent, matchCandidateTitle } from './matching-rules.js';

export type EpisodeReleaseKind = 'single-episode' | 'multi-episode' | 'season-pack' | 'none';

export type EpisodeMatchDecision = MatchDecision & {
  kind: EpisodeReleaseKind;
};

type EpisodeCoverage = {
  season: number;
  episodes: ReadonlySet<number>;
  kind: Exclude<EpisodeReleaseKind, 'none'>;
};

const minimumEpisodeScore = 75;

export function matchEpisode(
  metadata: MediaMetadata,
  candidate: MatchCandidate,
): EpisodeMatchDecision {
  if (metadata.type !== 'series' || candidate.mediaType !== 'series') {
    return unmatched('media type mismatch');
  }
  if (hasUnwantedContent(candidate)) {
    return unmatched('non-episode content');
  }

  const titleMatch = matchCandidateTitle(metadata, candidate);
  if (!titleMatch.matched) {
    return unmatched('title mismatch');
  }

  const coverage = coverageFromCandidate(candidate);
  if (coverage === undefined) {
    return unmatched('episode marker missing');
  }
  if (coverage.season !== metadata.season) {
    return unmatched('season mismatch');
  }
  if (coverage.kind !== 'season-pack' && !coverage.episodes.has(metadata.episode)) {
    return unmatched('episode mismatch');
  }

  const episodeScore = coverage.kind === 'season-pack' ? 15 : 30;
  const score = clampScore(titleMatch.score + episodeScore);
  const reasons = [titleMatch.reason ?? 'title match', coverage.kind];
  return { matched: score >= minimumEpisodeScore, score, reasons, kind: coverage.kind };
}

export function parseEpisodeCoverage(value: string): EpisodeCoverage | undefined {
  const normalized = value.replace(/[._ ]+/gu, ' ');
  const standard = /\bS(\d{1,2})\s*E(\d{1,3})(.*?)(?=\s|$)/iu.exec(normalized);
  if (standard !== null) {
    const season = Number(standard[1]);
    const firstEpisode = Number(standard[2]);
    const episodes = new Set<number>([firstEpisode]);
    const tail = standard[3] ?? '';
    for (const match of tail.matchAll(/(?:E|-)(\d{1,3})/giu)) {
      episodes.add(Number(match[1]));
    }
    const rangeEnd = /-E?(\d{1,3})/iu.exec(tail)?.[1];
    if (rangeEnd !== undefined) {
      addEpisodeRange(episodes, firstEpisode, Number(rangeEnd));
    }
    return {
      season,
      episodes,
      kind: episodes.size > 1 ? 'multi-episode' : 'single-episode',
    };
  }

  const alternate = /\b(\d{1,2})x(\d{1,3})(?:-(\d{1,3}))?\b/iu.exec(normalized);
  if (alternate !== null) {
    const firstEpisode = Number(alternate[2]);
    const episodes = new Set<number>([firstEpisode]);
    if (alternate[3] !== undefined) {
      addEpisodeRange(episodes, firstEpisode, Number(alternate[3]));
    }
    return {
      season: Number(alternate[1]),
      episodes,
      kind: episodes.size > 1 ? 'multi-episode' : 'single-episode',
    };
  }

  const seasonPack = /\b(?:S|Season\s*)(\d{1,2})\b/iu.exec(normalized);
  if (seasonPack !== null) {
    return { season: Number(seasonPack[1]), episodes: new Set(), kind: 'season-pack' };
  }

  return undefined;
}

function coverageFromCandidate(candidate: MatchCandidate): EpisodeCoverage | undefined {
  if (candidate.season !== undefined && candidate.episode !== undefined) {
    return {
      season: candidate.season,
      episodes: new Set([candidate.episode]),
      kind: 'single-episode',
    };
  }

  return parseEpisodeCoverage(`${candidate.releaseName} ${candidate.filename ?? ''}`);
}

function unmatched(reason: string): EpisodeMatchDecision {
  return { matched: false, score: 0, reasons: [reason], kind: 'none' };
}

function addEpisodeRange(episodes: Set<number>, start: number, end: number): void {
  if (end < start || end - start > 100) {
    return;
  }
  for (let episode = start; episode <= end; episode += 1) {
    episodes.add(episode);
  }
}
