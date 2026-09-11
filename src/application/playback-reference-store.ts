import { randomBytes } from 'node:crypto';

import type { MediaRequest } from '../domain/media.js';
import type { Resolution, TorrentProviderResult } from '../domain/release.js';

export type PrecacheCandidate = {
  result: TorrentProviderResult;
  matchScore: number;
};

export type PlaybackPrecachePolicy = {
  count: number;
  minimumMatchScore: number;
  minimumSeeders: number;
  maximumTorrentSizeBytes?: number;
  maximumTotalSizeBytes?: number;
  allowedResolutions: readonly Resolution[];
  preferredAudioLanguages: readonly string[];
  preferredSubtitleLanguages: readonly string[];
  preferredLanguagesOnly: boolean;
};

export type PlaybackReference = {
  id: string;
  configId: string;
  result: TorrentProviderResult;
  media: MediaRequest;
  allowUncached: boolean;
  precacheCandidates: readonly PrecacheCandidate[];
  precachePolicy: PlaybackPrecachePolicy;
  safeDebug?: boolean;
  expiresAt: number;
};

export type NewPlaybackReference = Omit<PlaybackReference, 'id' | 'expiresAt'>;

export type PlaybackReferenceStore = {
  put(reference: NewPlaybackReference): PlaybackReference;
  get(id: string): PlaybackReference | undefined;
  deleteNamespace(configId: string): void;
};

export type PlaybackReferenceStoreOptions = {
  ttlMs?: number;
  clock?: () => number;
  createId?: () => string;
  maximumEntries?: number;
};

const DEFAULT_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_MAXIMUM_ENTRIES = 2_000;

export const createPlaybackReferenceStore = (
  options: PlaybackReferenceStoreOptions = {},
): PlaybackReferenceStore => {
  const ttlMs = positiveInteger(options.ttlMs ?? DEFAULT_TTL_MS, 'playback reference TTL');
  const maximumEntries = positiveInteger(
    options.maximumEntries ?? DEFAULT_MAXIMUM_ENTRIES,
    'maximum playback references',
  );
  const clock = options.clock ?? Date.now;
  const createId = options.createId ?? (() => randomBytes(18).toString('base64url'));
  const references = new Map<string, PlaybackReference>();

  const prune = (): void => {
    const now = clock();
    for (const [id, reference] of references) {
      if (reference.expiresAt <= now) references.delete(id);
    }
    while (references.size >= maximumEntries) {
      const oldest = references.keys().next().value;
      if (oldest === undefined) break;
      references.delete(oldest);
    }
  };

  return {
    put(reference) {
      prune();
      const id = createId();
      if (!/^[A-Za-z\d_-]{16,200}$/u.test(id)) {
        throw new TypeError('Playback reference ID must be opaque and URL-safe');
      }
      if (references.has(id)) throw new TypeError('Playback reference ID collision');
      const stored = { ...reference, id, expiresAt: clock() + ttlMs };
      references.set(id, stored);
      return stored;
    },
    get(id) {
      const reference = references.get(id);
      if (reference === undefined) return undefined;
      if (reference.expiresAt <= clock()) {
        references.delete(id);
        return undefined;
      }
      return reference;
    },
    deleteNamespace(configId) {
      for (const [id, reference] of references) {
        if (reference.configId === configId) references.delete(id);
      }
    },
  };
};

const positiveInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be positive`);
  return value;
};
