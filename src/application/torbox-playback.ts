import type { MediaRequest } from '../domain/media.js';
import type { UserConfiguration } from '../domain/configuration.js';
import type { TorboxPlaybackUrlFactory } from '../http/stream-formatter.js';
import {
  TorboxTransportError,
  type TorboxApiClient,
} from '../providers/torbox/torbox-api-client.js';
import type { TorboxTorrent, TorboxTorrentFile } from '../providers/torbox/torbox-types.js';
import type { PlayTokenClaims, PlayTokenService } from '../security/play-token.js';
import type {
  PlaybackReference,
  PlaybackReferenceStore,
  PrecacheCandidate,
} from './playback-reference-store.js';
import type { TorboxPrecacheScheduler } from './torbox-precache.js';
import type { TorrentFileStore } from './torrent-file-store.js';
import {
  observeSearch,
  type SearchObserver,
  type TorboxPlaybackStage,
} from './search-observability.js';

export type TorboxCredential = {
  configId: string;
  apiKey: string;
};

export type TorboxCredentialStore = {
  get(configId: string): Promise<TorboxCredential | undefined>;
};

export type TorboxApiClientFactory = (apiKey: string) => TorboxApiClient;

export type PlaybackResolution = {
  url: string;
  filename: string;
  pending?: boolean;
};

export class PlaybackResolveError extends Error {
  override readonly name = 'PlaybackResolveError';

  constructor(
    readonly kind:
      | 'invalid-reference'
      | 'configuration-not-found'
      | 'torrent-unavailable'
      | 'invalid-provider-url',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
  }
}

export type TorboxPlaybackResolver = {
  inspect(token: string): Promise<void>;
  resolve(token: string, signal?: AbortSignal): Promise<PlaybackResolution>;
};

type TorboxPlayTokenClaims = Extract<PlayTokenClaims, { provider: 'sktorrent' | 'indexers' }>;

export type TorboxPlaybackResolverOptions = {
  tokens: PlayTokenService;
  references: PlaybackReferenceStore;
  credentials: TorboxCredentialStore;
  createClient: TorboxApiClientFactory;
  allowedPlaybackHosts?: readonly string[];
  pendingPlaybackUrl: string;
  resolutionTtlMs?: number;
  clock?: () => number;
  precache?: TorboxPrecacheScheduler;
  observer?: SearchObserver;
  torrentFiles?: TorrentFileStore;
  resolvePrecacheCandidates?: (
    reference: PlaybackReference,
  ) => Promise<readonly PrecacheCandidate[]>;
};

export type TorboxPlaybackUrlFactoryOptions = {
  baseUrl: string;
  configId: string;
  references: PlaybackReferenceStore;
};

const DEFAULT_ALLOWED_PLAYBACK_HOSTS = ['torbox.app', 'torboxcdn.com', 'tb-cdn.io'] as const;
const DEFAULT_RESOLUTION_TTL_MS = 2 * 60 * 1_000;

export const createTorboxPlaybackUrlFactory = (
  options: TorboxPlaybackUrlFactoryOptions,
): TorboxPlaybackUrlFactory => {
  const baseUrl = validateAddonBaseUrl(options.baseUrl);
  const configId = validateOpaqueId(options.configId, 'configuration ID');
  return (providerResult, media, _candidates, configuration) => {
    if (providerResult.magnetUri === undefined) {
      throw new TypeError('TorBox playback requires a verified magnet URI');
    }
    const reference = options.references.put({
      configId,
      result: providerResult,
      media,
      allowUncached: configuration.torbox.showUncached,
      precacheCandidates: [],
      precachePolicy: toPrecachePolicy(configuration),
      safeDebug: configuration.advanced?.safeDebug === true,
    });
    const token = reference.id;
    const action = providerResult.cacheStatus === 'uncached' ? 'download' : 'play';
    return new URL(`${action}/${encodeURIComponent(token)}/video.mp4`, baseUrl).toString();
  };
};

export const createTorboxPlaybackResolver = (
  options: TorboxPlaybackResolverOptions,
): TorboxPlaybackResolver => {
  const allowedHosts = (options.allowedPlaybackHosts ?? DEFAULT_ALLOWED_PLAYBACK_HOSTS).map(
    normalizeAllowedHost,
  );
  const resolutionTtlMs = positiveInteger(
    options.resolutionTtlMs ?? DEFAULT_RESOLUTION_TTL_MS,
    'playback resolution TTL',
  );
  const clock = options.clock ?? Date.now;
  const pendingPlaybackUrl = validatePendingPlaybackUrl(options.pendingPlaybackUrl);
  const resolutions = new Map<string, { value: Promise<PlaybackResolution>; expiresAt: number }>();

  const inspect = async (token: string): Promise<ValidatedPlayback> => {
    let reference = options.references.get(token);
    if (reference === undefined) {
      const claims = options.tokens.verify(token);
      if (claims.provider !== 'sktorrent' && claims.provider !== 'indexers') {
        throw new PlaybackResolveError('invalid-reference', 'Playback reference is invalid');
      }
      reference = options.references.get(claims.referenceId);
      if (reference === undefined || !referenceMatchesClaims(reference, claims)) {
        throw new PlaybackResolveError('invalid-reference', 'Playback reference is invalid');
      }
    }
    const credential = await options.credentials.get(reference.configId);
    if (credential?.configId !== reference.configId) {
      throw new PlaybackResolveError(
        'configuration-not-found',
        'Playback configuration is unavailable',
      );
    }
    if (credential.apiKey.trim().length === 0) {
      throw new PlaybackResolveError(
        'configuration-not-found',
        'Playback configuration is unavailable',
      );
    }
    return { reference, credential };
  };

  return {
    async inspect(token) {
      await inspect(token);
    },
    async resolve(token, signal) {
      const validated = await inspect(token);
      const existing = resolutions.get(token);
      if (existing !== undefined && existing.expiresAt > clock()) return existing.value;
      resolutions.delete(token);
      const value = resolvePlayback(
        validated,
        options.createClient,
        allowedHosts,
        pendingPlaybackUrl,
        options.precache,
        options.observer,
        options.torrentFiles,
        options.resolvePrecacheCandidates,
        clock,
        signal,
      );
      resolutions.set(token, { value, expiresAt: clock() + resolutionTtlMs });
      try {
        const resolution = await value;
        if (resolution.pending === true && resolutions.get(token)?.value === value) {
          resolutions.delete(token);
        }
        return resolution;
      } catch (error) {
        if (resolutions.get(token)?.value === value) resolutions.delete(token);
        throw error;
      }
    },
  };
};

type ValidatedPlayback = {
  reference: PlaybackReference;
  credential: TorboxCredential;
};

const resolvePlayback = async (
  playback: ValidatedPlayback,
  createClient: TorboxApiClientFactory,
  allowedHosts: readonly string[],
  pendingPlaybackUrl: string,
  precache: TorboxPrecacheScheduler | undefined,
  observer: SearchObserver | undefined,
  torrentFiles: TorrentFileStore | undefined,
  resolvePrecacheCandidates:
    ((reference: PlaybackReference) => Promise<readonly PrecacheCandidate[]>) | undefined,
  clock: () => number,
  signal?: AbortSignal,
): Promise<PlaybackResolution> => {
  const client = createClient(playback.credential.apiKey);
  const hash = playback.reference.result.infoHash.toLowerCase();
  const runStage = <Value>(stage: TorboxPlaybackStage, operation: () => Promise<Value>) =>
    observePlaybackStage(playback.reference, observer, clock, stage, operation);
  const accountTorrents = await runStage('list-torrents', () => client.listTorrents(signal));
  let torrent = accountTorrents.find((candidate) => candidate.hash.toLowerCase() === hash);
  if (torrent === undefined) {
    if (!playback.reference.allowUncached) {
      const cacheEntries = await runStage('check-cache', () => client.checkCached([hash], signal));
      const cacheStatus = cacheEntries.find((entry) => entry.hash.toLowerCase() === hash)?.status;
      if (cacheStatus !== 'cached') {
        throw new PlaybackResolveError(
          'torrent-unavailable',
          'The selected torrent is not cached on TorBox',
        );
      }
    }
    const magnetUri = playback.reference.result.magnetUri;
    if (magnetUri === undefined) {
      throw new PlaybackResolveError('invalid-reference', 'Verified magnet URI is unavailable');
    }
    const torrentFile = torrentFiles?.get(playback.reference.configId, hash);
    const created = await runStage('create-torrent', () =>
      torrentFile !== undefined && client.createTorrentFile !== undefined
        ? client.createTorrentFile(torrentFile, signal)
        : client.createTorrent(magnetUri, signal),
    );
    if (created.hash !== undefined && created.hash.toLowerCase() !== hash) {
      throw new PlaybackResolveError('invalid-reference', 'Created torrent hash does not match');
    }
    // TorBox may expose a newly-created magnet before its metadata and files are available.
    // Do not turn that expected transition into a 502; the next playback GET reads fresh state.
    return {
      url: pendingPlaybackUrl,
      filename: 'torbox-downloading.mp4',
      pending: true,
    };
  } else if (!isTorrentReady(torrent)) {
    const torrentId = torrent.id;
    torrent = await runStage('refresh-torrent', () => client.getTorrent(torrentId, signal));
  }
  if (!isTorrentReady(torrent)) {
    return {
      url: pendingPlaybackUrl,
      filename: 'torbox-downloading.mp4',
      pending: true,
    };
  }
  const file = selectVideoFile(
    torrent,
    playback.reference.media,
    playback.reference.result.filename,
  );
  if (file === undefined) {
    throw new PlaybackResolveError(
      'torrent-unavailable',
      'The selected torrent does not contain an available matching video file',
    );
  }
  const url = validateProviderPlaybackUrl(
    await runStage('request-download-link', () =>
      client.requestDownloadLink(torrent.id, file.id, signal),
    ),
    allowedHosts,
  );
  if (precache !== undefined) {
    try {
      void (async () => {
        const startedAt = clock();
        try {
          const precacheCandidates =
            resolvePrecacheCandidates === undefined
              ? playback.reference.precacheCandidates
              : await resolvePrecacheCandidates(playback.reference);
          if (playback.reference.safeDebug === true) {
            observeSearch(observer, {
              type: 'torbox-precache-stage',
              stage: 'discovery',
              outcome: 'complete',
              durationMs: Math.max(0, clock() - startedAt),
              candidateCount: precacheCandidates.length,
            });
          }
          await precache.schedule({
            reference: { ...playback.reference, precacheCandidates },
            client,
            accountTorrents,
            ...(torrentFiles === undefined ? {} : { torrentFiles }),
          });
        } catch (error) {
          if (playback.reference.safeDebug === true) {
            observeSearch(observer, {
              type: 'torbox-precache-stage',
              stage: 'discovery',
              outcome: 'failed',
              durationMs: Math.max(0, clock() - startedAt),
              category: error instanceof TorboxTransportError ? error.kind : 'unexpected',
              ...(error instanceof TorboxTransportError && error.statusCode !== undefined
                ? { statusCode: error.statusCode }
                : {}),
            });
          }
        }
      })();
    } catch {
      // Precache nesmie ovplyvniť prehratie vybraného streamu.
    }
  }
  return { url, filename: file.name };
};

const observePlaybackStage = async <Value>(
  reference: PlaybackReference,
  observer: SearchObserver | undefined,
  clock: () => number,
  stage: TorboxPlaybackStage,
  operation: () => Promise<Value>,
): Promise<Value> => {
  const startedAt = clock();
  try {
    const value = await operation();
    if (reference.safeDebug === true) {
      observeSearch(observer, {
        type: 'torbox-playback-stage',
        stage,
        outcome: 'complete',
        durationMs: Math.max(0, clock() - startedAt),
      });
    }
    return value;
  } catch (error) {
    if (reference.safeDebug === true) {
      observeSearch(observer, {
        type: 'torbox-playback-stage',
        stage,
        outcome: 'failed',
        durationMs: Math.max(0, clock() - startedAt),
        category: error instanceof TorboxTransportError ? error.kind : 'unexpected',
        ...(error instanceof TorboxTransportError && error.statusCode !== undefined
          ? { statusCode: error.statusCode }
          : {}),
      });
    }
    throw error;
  }
};

const toPrecachePolicy = (
  configuration: UserConfiguration,
): PlaybackReference['precachePolicy'] => {
  const limits = configuration.torbox.precacheLimits;
  const maximumTorrentSizeBytes = positiveOptional(limits?.maximumTorrentSizeBytes);
  const maximumTotalSizeBytes = positiveOptional(limits?.maximumTotalSizeBytes);
  return {
    count: clampInteger(configuration.torbox.precacheCount, 0, 10),
    minimumMatchScore: clampNumber(limits?.minimumMatchScore ?? 0, 0),
    minimumSeeders: clampInteger(
      limits?.minimumSeeders ?? configuration.filters.minimumSeeders,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    ...(maximumTorrentSizeBytes === undefined ? {} : { maximumTorrentSizeBytes }),
    ...(maximumTotalSizeBytes === undefined ? {} : { maximumTotalSizeBytes }),
    allowedResolutions: [
      ...new Set(limits?.allowedResolutions ?? configuration.filters.resolutions),
    ],
    preferredAudioLanguages: [...configuration.languages.audio.preferred],
    preferredSubtitleLanguages: [...configuration.languages.subtitles.preferred],
    preferredLanguagesOnly: limits?.preferredLanguagesOnly ?? false,
  };
};

const clampInteger = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? Math.floor(value) : minimum));

const clampNumber = (value: number, minimum: number): number =>
  Math.max(minimum, Number.isFinite(value) ? value : minimum);

const positiveOptional = (value: number | undefined): number | undefined =>
  value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;

export const selectVideoFile = (
  torrent: TorboxTorrent,
  media: MediaRequest,
  selectedFilename?: string,
): TorboxTorrentFile | undefined => {
  const videos = torrent.files.filter((file) => VIDEO_EXTENSION.test(file.name));
  if (selectedFilename !== undefined) {
    const exact = videos.find(
      (file) => file.name.toLocaleLowerCase('en') === selectedFilename.toLocaleLowerCase('en'),
    );
    if (exact !== undefined) return exact;
  }
  const matches =
    media.type === 'series'
      ? videos.filter((file) => matchesEpisode(file.name, media.season, media.episode))
      : videos;
  return [...matches].sort(
    (left, right) =>
      (right.sizeBytes ?? 0) - (left.sizeBytes ?? 0) || left.name.localeCompare(right.name, 'en'),
  )[0];
};

const VIDEO_EXTENSION = /\.(?:mkv|mp4|m4v|avi|mov|webm|ts|m2ts)$/iu;

export const isTorrentReady = (torrent: TorboxTorrent): boolean => {
  if (torrent.downloadFinished !== undefined || torrent.downloadPresent !== undefined) {
    return torrent.downloadFinished === true && torrent.downloadPresent === true;
  }
  const state = torrent.downloadState.trim().toLocaleLowerCase('en-US');
  return state === 'cached' || state === 'uploading' || state === 'uploading (no peers)';
};

const matchesEpisode = (name: string, season: number, episode: number): boolean => {
  const patterns = [
    new RegExp(`(?:^|[^a-z\\d])s0*${String(season)}e0*${String(episode)}(?:[^\\d]|$)`, 'iu'),
    new RegExp(`(?:^|[^\\d])0*${String(season)}x0*${String(episode)}(?:[^\\d]|$)`, 'iu'),
  ];
  return patterns.some((pattern) => pattern.test(name));
};

const referenceMatchesClaims = (
  reference: PlaybackReference,
  claims: TorboxPlayTokenClaims,
): boolean =>
  reference.configId === claims.configId &&
  reference.result.id === claims.providerResultId &&
  reference.result.infoHash.toLowerCase() === claims.infoHash &&
  reference.media.type === claims.mediaType &&
  reference.media.id === claims.mediaId &&
  (reference.media.type === 'movie' ||
    (reference.media.season === claims.season && reference.media.episode === claims.episode));

const validateProviderPlaybackUrl = (value: string, allowedHosts: readonly string[]): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new PlaybackResolveError('invalid-provider-url', 'TorBox returned an invalid URL', {
      cause: error,
    });
  }
  if (
    url.protocol !== 'https:' ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    !allowedHosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))
  ) {
    throw new PlaybackResolveError('invalid-provider-url', 'TorBox returned a disallowed URL');
  }
  return url.toString();
};

const validateAddonBaseUrl = (value: string): URL => {
  const url = new URL(value);
  const local = url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
  if (url.protocol !== 'https:' && !local) {
    throw new TypeError('Addon playback base URL must use HTTPS outside local development');
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  url.search = '';
  url.hash = '';
  return url;
};

const validatePendingPlaybackUrl = (value: string): string => {
  const url = new URL(value);
  const local = url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !local) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new TypeError('TorBox pending playback URL is invalid');
  }
  return url.toString();
};

const normalizeAllowedHost = (value: string): string => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/gu, '');
  if (!/^[a-z\d.-]+$/u.test(normalized) || normalized.length === 0) {
    throw new TypeError('TorBox playback host allowlist contains an invalid host');
  }
  return normalized;
};

const validateOpaqueId = (value: string, name: string): string => {
  const normalized = value.trim();
  if (!/^[A-Za-z\d_-]{16,200}$/u.test(normalized)) {
    throw new TypeError(`TorBox ${name} must be opaque and URL-safe`);
  }
  return normalized;
};

const positiveInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be positive`);
  return value;
};
