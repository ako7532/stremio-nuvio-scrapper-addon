import type { MediaType } from '../domain/media.js';

export type MatchCandidate = {
  title: string;
  releaseName: string;
  filename?: string;
  mediaType: MediaType;
  year?: number;
  season?: number;
  episode?: number;
};

export type MatchDecision = {
  matched: boolean;
  score: number;
  reasons: readonly string[];
};
