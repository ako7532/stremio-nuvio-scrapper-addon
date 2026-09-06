import { randomBytes } from 'node:crypto';

import type { MediaRequest } from '../domain/media.js';
import type { WebsharePlaybackUrlFactory } from '../http/stream-formatter.js';
import { createWebshareApiClient } from '../providers/webshare/webshare-api-client.js';
import { createWebshareCredentialService } from '../providers/webshare/webshare-credentials.js';
import { createWebshareSource } from '../providers/webshare/webshare-source.js';
import type { PlayTokenClaims, PlayTokenService } from '../security/play-token.js';
import { PlaybackResolveError, type PlaybackResolution } from './torbox-playback.js';

type WebshareClaims = Extract<PlayTokenClaims, { provider: 'webshare' }>;
type WebshareReference = {
  id: string;
  configId: string;
  fileId: string;
  media?: MediaRequest;
  expiresAt: number;
};

export type WebshareCredentialStore = {
  get(
    configId: string,
  ): Promise<{ configId: string; username: string; password: string } | undefined>;
};

export type WebsharePlaybackResolver = {
  inspect(token: string): Promise<void>;
  resolve(token: string, signal?: AbortSignal): Promise<PlaybackResolution>;
};

export type WebsharePlaybackAssembly = {
  urlFactory(configId: string): WebsharePlaybackUrlFactory;
  resolver: WebsharePlaybackResolver;
};

export const createWebsharePlaybackAssembly = (options: {
  baseUrl: string;
  tokens: PlayTokenService;
  credentials: WebshareCredentialStore;
  allowedPlaybackHosts: readonly string[];
  timeoutMs?: number;
  referenceTtlMs?: number;
  resolutionTtlMs?: number;
  maximumReferences?: number;
  clock?: () => number;
  resolvePlayback?: (
    credential: { username: string; password: string },
    fileId: string,
    signal?: AbortSignal,
  ) => Promise<string>;
}): WebsharePlaybackAssembly => {
  const baseUrl = validateBaseUrl(options.baseUrl);
  const allowedHosts = options.allowedPlaybackHosts.map(normalizeHost);
  if (allowedHosts.length === 0) {
    throw new TypeError('Webshare playback requires an explicit host allowlist');
  }
  const referenceTtlMs = positiveInteger(options.referenceTtlMs ?? 5 * 60_000, 'reference TTL');
  const resolutionTtlMs = positiveInteger(options.resolutionTtlMs ?? 30_000, 'resolution TTL');
  const maximumReferences = positiveInteger(
    options.maximumReferences ?? 2_000,
    'maximum references',
  );
  const clock = options.clock ?? Date.now;
  const references = new Map<string, WebshareReference>();
  const resolutions = new Map<string, { value: Promise<PlaybackResolution>; expiresAt: number }>();

  const inspect = async (
    token: string,
  ): Promise<{
    claims: WebshareClaims;
    reference: WebshareReference;
    credential: NonNullable<Awaited<ReturnType<WebshareCredentialStore['get']>>>;
  }> => {
    const claims = options.tokens.verify(token);
    if (claims.provider !== 'webshare') throw invalidReference();
    const reference = references.get(claims.referenceId);
    if (reference === undefined || reference.expiresAt <= clock()) {
      references.delete(claims.referenceId);
      throw invalidReference();
    }
    if (!referenceMatches(reference, claims)) throw invalidReference();
    const credential = await options.credentials.get(claims.configId);
    if (credential?.configId !== claims.configId) {
      throw new PlaybackResolveError(
        'configuration-not-found',
        'Playback configuration is unavailable',
      );
    }
    return { claims, reference, credential };
  };

  return {
    urlFactory(configId) {
      const normalizedConfigId = opaqueId(configId, 'configuration ID');
      return (result, media) => {
        prune(references, clock());
        while (references.size >= maximumReferences) {
          const oldest = references.keys().next().value;
          if (oldest === undefined) break;
          references.delete(oldest);
        }
        const id = randomBytes(18).toString('base64url');
        const reference: WebshareReference = {
          id,
          configId: normalizedConfigId,
          fileId: result.fileId,
          ...(media === undefined ? {} : { media }),
          expiresAt: clock() + referenceTtlMs,
        };
        references.set(id, reference);
        const token = options.tokens.issue(claimsFor(reference));
        return new URL(`play/${encodeURIComponent(token)}`, baseUrl).toString();
      };
    },
    resolver: {
      async inspect(token) {
        await inspect(token);
      },
      async resolve(token, signal) {
        const validated = await inspect(token);
        const existing = resolutions.get(token);
        if (existing !== undefined && existing.expiresAt > clock()) return existing.value;
        resolutions.delete(token);
        const value = (async (): Promise<PlaybackResolution> => {
          const resolvePlayback =
            options.resolvePlayback ??
            (async (credential, fileId, playbackSignal) => {
              const api = createWebshareApiClient({
                ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
              });
              const source = createWebshareSource(
                api,
                createWebshareCredentialService(api, credential),
              );
              return source.resolvePlayback(fileId, playbackSignal);
            });
          const url = validatePlaybackUrl(
            await resolvePlayback(
              {
                username: validated.credential.username,
                password: validated.credential.password,
              },
              validated.reference.fileId,
              signal,
            ),
            allowedHosts,
          );
          return { url, filename: validated.reference.fileId };
        })();
        resolutions.set(token, { value, expiresAt: clock() + resolutionTtlMs });
        try {
          return await value;
        } catch (error) {
          if (resolutions.get(token)?.value === value) resolutions.delete(token);
          throw error;
        }
      },
    },
  };
};

const claimsFor = (reference: WebshareReference): Omit<WebshareClaims, 'expiresAt'> => ({
  configId: reference.configId,
  referenceId: reference.id,
  provider: 'webshare',
  providerResultId: reference.fileId,
  mediaType: reference.media?.type ?? 'movie',
  mediaId: reference.media?.id ?? reference.fileId,
  ...(reference.media?.type === 'series'
    ? { season: reference.media.season, episode: reference.media.episode }
    : {}),
});

const referenceMatches = (reference: WebshareReference, claims: WebshareClaims): boolean =>
  reference.configId === claims.configId &&
  reference.fileId === claims.providerResultId &&
  (reference.media === undefined ||
    (reference.media.type === claims.mediaType &&
      reference.media.id === claims.mediaId &&
      (reference.media.type === 'movie' ||
        (reference.media.season === claims.season && reference.media.episode === claims.episode))));

const validatePlaybackUrl = (value: string, allowedHosts: readonly string[]): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new PlaybackResolveError('invalid-provider-url', 'Webshare returned an invalid URL', {
      cause: error,
    });
  }
  if (
    url.protocol !== 'https:' ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    !allowedHosts.includes(url.hostname.toLowerCase())
  ) {
    throw new PlaybackResolveError('invalid-provider-url', 'Webshare returned a disallowed URL');
  }
  return url.toString();
};

const validateBaseUrl = (value: string): URL => {
  const url = new URL(value);
  const local = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
  if (
    (!local && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new TypeError('Invalid addon base URL');
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
};

const normalizeHost = (value: string): string => {
  const host = value.trim().toLowerCase();
  if (
    !/^(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?)(?:\.(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?))+$/u.test(
      host,
    )
  ) {
    throw new TypeError('Invalid Webshare playback host');
  }
  return host;
};

const opaqueId = (value: string, name: string): string => {
  if (!/^[A-Za-z\d_-]{16,200}$/u.test(value)) throw new TypeError(`Invalid ${name}`);
  return value;
};

const prune = (references: Map<string, WebshareReference>, now: number): void => {
  for (const [id, reference] of references) if (reference.expiresAt <= now) references.delete(id);
};

const positiveInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be positive`);
  return value;
};

const invalidReference = (): PlaybackResolveError =>
  new PlaybackResolveError('invalid-reference', 'Playback reference is invalid');
