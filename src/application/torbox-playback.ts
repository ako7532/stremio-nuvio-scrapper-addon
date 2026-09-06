import type { MediaRequest } from '../domain/media.js';
import type { TorboxPlaybackUrlFactory } from '../http/stream-formatter.js';
import type { TorboxApiClient } from '../providers/torbox/torbox-api-client.js';
import type { TorboxTorrent, TorboxTorrentFile } from '../providers/torbox/torbox-types.js';
import type { PlayTokenClaims, PlayTokenService } from '../security/play-token.js';
import type { PlaybackReference, PlaybackReferenceStore } from './playback-reference-store.js';

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

export type TorboxPlaybackResolverOptions = {
  tokens: PlayTokenService;
  references: PlaybackReferenceStore;
  credentials: TorboxCredentialStore;
  createClient: TorboxApiClientFactory;
  allowedPlaybackHosts?: readonly string[];
  resolutionTtlMs?: number;
  clock?: () => number;
};

export type TorboxPlaybackUrlFactoryOptions = {
  baseUrl: string;
  configId: string;
  tokens: PlayTokenService;
  references: PlaybackReferenceStore;
};

const DEFAULT_ALLOWED_PLAYBACK_HOSTS = ['torbox.app', 'torboxcdn.com'] as const;
const DEFAULT_RESOLUTION_TTL_MS = 2 * 60 * 1_000;

export const createTorboxPlaybackUrlFactory = (
  options: TorboxPlaybackUrlFactoryOptions,
): TorboxPlaybackUrlFactory => {
  const baseUrl = validateAddonBaseUrl(options.baseUrl);
  const configId = validateOpaqueId(options.configId, 'configuration ID');
  return (providerResult, media) => {
    if (providerResult.magnetUri === undefined) {
      throw new TypeError('TorBox playback requires a verified magnet URI');
    }
    const reference = options.references.put({ configId, result: providerResult, media });
    const token = options.tokens.issue(claimsFor(reference));
    return new URL(`play/${encodeURIComponent(token)}`, baseUrl).toString();
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
  const resolutions = new Map<string, { value: Promise<PlaybackResolution>; expiresAt: number }>();

  const inspect = async (token: string): Promise<ValidatedPlayback> => {
    const claims = options.tokens.verify(token);
    const reference = options.references.get(claims.referenceId);
    if (reference === undefined || !referenceMatchesClaims(reference, claims)) {
      throw new PlaybackResolveError('invalid-reference', 'Playback reference is invalid');
    }
    const credential = await options.credentials.get(claims.configId);
    if (credential?.configId !== claims.configId) {
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
    return { claims, reference, credential };
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
      const value = resolvePlayback(validated, options.createClient, allowedHosts, signal);
      resolutions.set(token, { value, expiresAt: clock() + resolutionTtlMs });
      try {
        return await value;
      } catch (error) {
        if (resolutions.get(token)?.value === value) resolutions.delete(token);
        throw error;
      }
    },
  };
};

type ValidatedPlayback = {
  claims: PlayTokenClaims;
  reference: PlaybackReference;
  credential: TorboxCredential;
};

const resolvePlayback = async (
  playback: ValidatedPlayback,
  createClient: TorboxApiClientFactory,
  allowedHosts: readonly string[],
  signal?: AbortSignal,
): Promise<PlaybackResolution> => {
  const client = createClient(playback.credential.apiKey);
  const hash = playback.reference.result.infoHash.toLowerCase();
  const accountTorrents = await client.listTorrents(signal);
  let torrent = accountTorrents.find((candidate) => candidate.hash.toLowerCase() === hash);
  if (torrent === undefined) {
    const magnetUri = playback.reference.result.magnetUri;
    if (magnetUri === undefined) {
      throw new PlaybackResolveError('invalid-reference', 'Verified magnet URI is unavailable');
    }
    const created = await client.createTorrent(magnetUri, signal);
    if (created.hash !== undefined && created.hash.toLowerCase() !== hash) {
      throw new PlaybackResolveError('invalid-reference', 'Created torrent hash does not match');
    }
    torrent = await client.getTorrent(created.id, signal);
    if (torrent.hash.toLowerCase() !== hash) {
      throw new PlaybackResolveError('invalid-reference', 'Resolved torrent hash does not match');
    }
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
    await client.requestDownloadLink(torrent.id, file.id, signal),
    allowedHosts,
  );
  return { url, filename: file.name };
};

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

const matchesEpisode = (name: string, season: number, episode: number): boolean => {
  const patterns = [
    new RegExp(`(?:^|[^a-z\\d])s0*${String(season)}e0*${String(episode)}(?:[^\\d]|$)`, 'iu'),
    new RegExp(`(?:^|[^\\d])0*${String(season)}x0*${String(episode)}(?:[^\\d]|$)`, 'iu'),
  ];
  return patterns.some((pattern) => pattern.test(name));
};

const claimsFor = (reference: PlaybackReference): Omit<PlayTokenClaims, 'expiresAt'> => ({
  configId: reference.configId,
  referenceId: reference.id,
  provider: 'sktorrent',
  providerResultId: reference.result.id,
  infoHash: reference.result.infoHash.toLowerCase(),
  mediaType: reference.media.type,
  mediaId: reference.media.id,
  ...(reference.media.type === 'series'
    ? { season: reference.media.season, episode: reference.media.episode }
    : {}),
});

const referenceMatchesClaims = (reference: PlaybackReference, claims: PlayTokenClaims): boolean =>
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
