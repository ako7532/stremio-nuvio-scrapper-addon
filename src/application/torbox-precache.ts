import type {
  PlaybackPrecachePolicy,
  PlaybackReference,
  PrecacheCandidate,
} from './playback-reference-store.js';
import type { TorboxApiClient } from '../providers/torbox/torbox-api-client.js';
import { TorboxTransportError } from '../providers/torbox/torbox-api-client.js';
import type { TorboxTorrent } from '../providers/torbox/torbox-types.js';
import type { TorrentFileStore } from './torrent-file-store.js';
import { observeSearch, type SearchObserver } from './search-observability.js';

export type TorboxPrecacheRequest = {
  reference: PlaybackReference;
  client: TorboxApiClient;
  accountTorrents: readonly TorboxTorrent[];
  torrentFiles?: TorrentFileStore;
};

export type TorboxPrecacheScheduler = {
  schedule(request: TorboxPrecacheRequest): Promise<void>;
};

export type TorboxPrecacheOptions = {
  maximumCreatesPerWindow?: number;
  windowMs?: number;
  defaultBackoffMs?: number;
  maximumBackoffMs?: number;
  maximumTrackedEntries?: number;
  clock?: () => number;
  observer?: SearchObserver;
};

type UserState = {
  windowStartedAt: number;
  creates: number;
  blockedUntil: number;
  failureCount: number;
};

const DEFAULT_MAXIMUM_CREATES_PER_WINDOW = 60;
const DEFAULT_WINDOW_MS = 60 * 60_000;
const DEFAULT_BACKOFF_MS = 5_000;
const DEFAULT_MAXIMUM_BACKOFF_MS = 5 * 60_000;
const DEFAULT_MAXIMUM_TRACKED_ENTRIES = 2_000;

export const createTorboxPrecacheScheduler = (
  options: TorboxPrecacheOptions = {},
): TorboxPrecacheScheduler => {
  const maximumCreatesPerWindow = positiveInteger(
    options.maximumCreatesPerWindow ?? DEFAULT_MAXIMUM_CREATES_PER_WINDOW,
    'maximum precache creates per window',
  );
  const windowMs = positiveInteger(options.windowMs ?? DEFAULT_WINDOW_MS, 'precache window');
  const defaultBackoffMs = positiveInteger(
    options.defaultBackoffMs ?? DEFAULT_BACKOFF_MS,
    'precache backoff',
  );
  const maximumBackoffMs = positiveInteger(
    options.maximumBackoffMs ?? DEFAULT_MAXIMUM_BACKOFF_MS,
    'maximum precache backoff',
  );
  const maximumTrackedEntries = positiveInteger(
    options.maximumTrackedEntries ?? DEFAULT_MAXIMUM_TRACKED_ENTRIES,
    'maximum tracked precache entries',
  );
  const clock = options.clock ?? Date.now;
  const startedReferences = new Map<string, number>();
  const completedHashes = new Map<string, number>();
  const inFlightHashes = new Set<string>();
  const userStates = new Map<string, UserState>();
  const userQueues = new Map<string, Promise<void>>();

  const schedule = (request: TorboxPrecacheRequest): Promise<void> => {
    prune(clock(), startedReferences, completedHashes);
    if (request.reference.precachePolicy.count === 0) return Promise.resolve();
    if (startedReferences.has(request.reference.id)) return Promise.resolve();
    const configId = request.reference.configId;
    if (!userQueues.has(configId) && userQueues.size >= maximumTrackedEntries) {
      return Promise.resolve();
    }
    setBounded(
      startedReferences,
      request.reference.id,
      request.reference.expiresAt,
      maximumTrackedEntries,
    );
    const previous = userQueues.get(configId) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() =>
        runPrecache(request, {
          maximumCreatesPerWindow,
          windowMs,
          defaultBackoffMs,
          maximumBackoffMs,
          maximumTrackedEntries,
          clock,
          completedHashes,
          inFlightHashes,
          userStates,
          observer: options.observer,
        }),
      )
      .catch(() => undefined);
    userQueues.set(configId, current);
    void current.finally(() => {
      if (userQueues.get(configId) === current) userQueues.delete(configId);
    });
    return current;
  };

  return { schedule };
};

type Runtime = {
  maximumCreatesPerWindow: number;
  windowMs: number;
  defaultBackoffMs: number;
  maximumBackoffMs: number;
  maximumTrackedEntries: number;
  clock: () => number;
  completedHashes: Map<string, number>;
  inFlightHashes: Set<string>;
  userStates: Map<string, UserState>;
  observer: SearchObserver | undefined;
};

const runPrecache = async (request: TorboxPrecacheRequest, runtime: Runtime): Promise<void> => {
  const { reference } = request;
  const accountHashes = new Set(
    request.accountTorrents.map((torrent) => torrent.hash.toLocaleLowerCase('en')),
  );
  accountHashes.add(reference.result.infoHash.toLocaleLowerCase('en'));
  const candidates = selectPrecacheCandidates(
    reference.precacheCandidates,
    reference.precachePolicy,
    accountHashes,
  );
  if (reference.safeDebug === true) {
    observeSearch(runtime.observer, {
      type: 'torbox-precache-stage',
      stage: 'selection',
      outcome: 'complete',
      durationMs: 0,
      candidateCount: candidates.length,
    });
  }

  for (const candidate of candidates) {
    const now = runtime.clock();
    const state = currentUserState(reference.configId, now, runtime);
    if (state.blockedUntil > now || state.creates >= runtime.maximumCreatesPerWindow) break;

    const hash = candidate.result.infoHash.toLocaleLowerCase('en');
    const key = `${reference.configId}:${hash}`;
    if (runtime.inFlightHashes.has(key) || (runtime.completedHashes.get(key) ?? 0) > now) continue;
    const magnetUri = candidate.result.magnetUri;
    if (magnetUri === undefined) continue;

    runtime.inFlightHashes.add(key);
    state.creates += 1;
    const startedAt = runtime.clock();
    try {
      const torrentFile = request.torrentFiles?.get(reference.configId, hash);
      if (torrentFile !== undefined && request.client.createTorrentFile !== undefined) {
        await request.client.createTorrentFile(torrentFile);
      } else {
        await request.client.createTorrent(magnetUri);
      }
      state.failureCount = 0;
      if (reference.safeDebug === true) {
        observeSearch(runtime.observer, {
          type: 'torbox-precache-stage',
          stage: 'create-torrent',
          outcome: 'complete',
          durationMs: Math.max(0, runtime.clock() - startedAt),
          ...(candidate.result.season === undefined ? {} : { season: candidate.result.season }),
          ...(candidate.result.episode === undefined ? {} : { episode: candidate.result.episode }),
        });
      }
      setBounded(runtime.completedHashes, key, reference.expiresAt, runtime.maximumTrackedEntries);
    } catch (error) {
      if (reference.safeDebug === true) {
        observeSearch(runtime.observer, {
          type: 'torbox-precache-stage',
          stage: 'create-torrent',
          outcome: 'failed',
          durationMs: Math.max(0, runtime.clock() - startedAt),
          ...(candidate.result.season === undefined ? {} : { season: candidate.result.season }),
          ...(candidate.result.episode === undefined ? {} : { episode: candidate.result.episode }),
          category: error instanceof TorboxTransportError ? error.kind : 'unexpected',
          ...(error instanceof TorboxTransportError && error.statusCode !== undefined
            ? { statusCode: error.statusCode }
            : {}),
          ...(error instanceof TorboxTransportError && error.errorCode !== undefined
            ? { errorCode: error.errorCode }
            : {}),
        });
      }
      if (isCandidateRejection(error)) continue;
      applyBackoff(state, error, now, runtime);
      break;
    } finally {
      runtime.inFlightHashes.delete(key);
    }
  }
};

const isCandidateRejection = (error: unknown): boolean =>
  error instanceof TorboxTransportError &&
  error.kind !== 'authentication-failed' &&
  error.kind !== 'rate-limited' &&
  ((error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 500) ||
    error.errorCode === 'DOWNLOAD_SERVER_ERROR');

export const selectPrecacheCandidates = (
  candidates: readonly PrecacheCandidate[],
  policy: PlaybackPrecachePolicy,
  excludedHashes: ReadonlySet<string>,
): readonly PrecacheCandidate[] => {
  const selected: PrecacheCandidate[] = [];
  const seen = new Set([...excludedHashes].map((hash) => hash.toLocaleLowerCase('en')));
  let totalSize = 0;

  for (const candidate of candidates) {
    if (selected.length >= policy.count) break;
    const { result } = candidate;
    const hash = result.infoHash.toLocaleLowerCase('en');
    if (seen.has(hash) || result.cacheStatus === 'unknown' || result.magnetUri === undefined)
      continue;
    if (candidate.matchScore < policy.minimumMatchScore) continue;
    if ((result.seeders ?? 0) < policy.minimumSeeders) continue;
    if (
      result.parsed === undefined ||
      !policy.allowedResolutions.includes(result.parsed.resolution) ||
      !matchesPreferredLanguages(candidate, policy)
    ) {
      continue;
    }
    if (
      policy.maximumTorrentSizeBytes !== undefined &&
      (result.sizeBytes === undefined || result.sizeBytes > policy.maximumTorrentSizeBytes)
    ) {
      continue;
    }
    if (policy.maximumTotalSizeBytes !== undefined) {
      if (
        result.sizeBytes === undefined ||
        totalSize + result.sizeBytes > policy.maximumTotalSizeBytes
      ) {
        continue;
      }
    }
    seen.add(hash);
    selected.push(candidate);
    totalSize += result.sizeBytes ?? 0;
  }
  return selected;
};

const matchesPreferredLanguages = (
  candidate: PrecacheCandidate,
  policy: PlaybackPrecachePolicy,
): boolean => {
  if (!policy.preferredLanguagesOnly) return true;
  const languages = candidate.result.parsed?.languages;
  if (languages === undefined) return false;
  const preferred = new Set([
    ...policy.preferredAudioLanguages,
    ...policy.preferredSubtitleLanguages,
  ]);
  return (
    preferred.size === 0 ||
    [...languages.audio, ...languages.subtitles].some((language) => preferred.has(language))
  );
};

const currentUserState = (configId: string, now: number, runtime: Runtime): UserState => {
  let state = runtime.userStates.get(configId);
  if (state === undefined || state.windowStartedAt + runtime.windowMs <= now) {
    state = {
      windowStartedAt: now,
      creates: 0,
      blockedUntil: state?.blockedUntil ?? 0,
      failureCount: 0,
    };
    setBounded(runtime.userStates, configId, state, runtime.maximumTrackedEntries);
  }
  return state;
};

const applyBackoff = (state: UserState, error: unknown, now: number, runtime: Runtime): void => {
  state.failureCount += 1;
  const exponential = Math.min(
    runtime.maximumBackoffMs,
    runtime.defaultBackoffMs * 2 ** Math.min(state.failureCount - 1, 10),
  );
  const retryAfter =
    error instanceof TorboxTransportError && error.kind === 'rate-limited'
      ? error.retryAfterMs
      : undefined;
  state.blockedUntil = now + Math.max(exponential, retryAfter ?? 0);
};

const prune = (
  now: number,
  startedReferences: Map<string, number>,
  completedHashes: Map<string, number>,
): void => {
  for (const [id, expiresAt] of startedReferences) {
    if (expiresAt <= now) startedReferences.delete(id);
  }
  for (const [hash, expiresAt] of completedHashes) {
    if (expiresAt <= now) completedHashes.delete(hash);
  }
};

const setBounded = <Key, Value>(
  values: Map<Key, Value>,
  key: Key,
  value: Value,
  maximumEntries: number,
): void => {
  values.delete(key);
  while (values.size >= maximumEntries) {
    const oldest = values.keys().next().value;
    if (oldest === undefined) break;
    values.delete(oldest);
  }
  values.set(key, value);
};

const positiveInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be positive`);
  return value;
};
