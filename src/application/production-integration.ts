import type { ConfigurationService } from './configuration-service.js';
import type { StoredConfiguration } from './configuration-store.js';
import { ApplicationError } from './application-error.js';
import { createPlaybackReferenceStore } from './playback-reference-store.js';
import { createSearchStreams, type SearchStreams } from './search-streams.js';
import { createTorboxCacheEnricher } from './torbox-cache-enricher.js';
import {
  createTorboxPlaybackResolver,
  createTorboxPlaybackUrlFactory,
  PlaybackResolveError,
  type TorboxPlaybackResolver,
} from './torbox-playback.js';
import { createTorboxPrecacheScheduler } from './torbox-precache.js';
import { createWebsharePlaybackAssembly } from './webshare-playback.js';
import { OrderedMetadataResolver } from '../metadata/metadata-resolver.js';
import { createTmdbClient } from '../metadata/tmdb-client.js';
import type { TmdbClient } from '../metadata/tmdb-client.js';
import { createTmdbMetadataSource } from '../metadata/tmdb-metadata-resolver.js';
import { createSktorrentProvider } from '../providers/sktorrent/sktorrent-provider.js';
import { createSktorrentSource } from '../providers/sktorrent/sktorrent-source.js';
import { createTorboxApiClient } from '../providers/torbox/torbox-api-client.js';
import type { TorboxApiClient } from '../providers/torbox/torbox-api-client.js';
import { createWebshareApiClient } from '../providers/webshare/webshare-api-client.js';
import { createWebshareCredentialService } from '../providers/webshare/webshare-credentials.js';
import { createWebshareProvider } from '../providers/webshare/webshare-provider.js';
import { createWebshareSource } from '../providers/webshare/webshare-source.js';
import { createPlayTokenService } from '../security/play-token.js';
import type { StreamProvider } from '../providers/provider.js';

export type ProductionIntegration = {
  searchStreamsForConfiguration(configuration: StoredConfiguration): SearchStreams;
  playbackResolver: TorboxPlaybackResolver;
  invalidate(configId: string): void;
};

export type ProductionIntegrationOptions = {
  configurationService: ConfigurationService;
  baseUrl: string;
  playbackSecret: Uint8Array;
  websharePlaybackHosts?: readonly string[];
  runtimeTtlMs?: number;
  maximumRuntimes?: number;
  clock?: () => number;
  factories?: {
    tmdbClient?: (accessToken: string, timeoutMs: number) => TmdbClient;
    sktorrentProvider?: (
      configuration: StoredConfiguration,
      timeoutMs: number,
    ) => StreamProvider | undefined;
    webshareProvider?: (
      configuration: StoredConfiguration,
      timeoutMs: number,
    ) => StreamProvider | undefined;
    torboxClient?: (apiKey: string, timeoutMs: number) => TorboxApiClient;
  };
};

type RuntimeEntry = { updatedAt: string; search: SearchStreams; expiresAt: number };

export const createProductionIntegration = (
  options: ProductionIntegrationOptions,
): ProductionIntegration => {
  const clock = options.clock ?? Date.now;
  const runtimeTtlMs = positiveInteger(options.runtimeTtlMs ?? 30 * 60_000, 'runtime TTL');
  const maximumRuntimes = positiveInteger(options.maximumRuntimes ?? 200, 'maximum runtimes');
  const tokens = createPlayTokenService({ secret: options.playbackSecret });
  const references = createPlaybackReferenceStore();
  const precache = createTorboxPrecacheScheduler();
  const torboxResolver = createTorboxPlaybackResolver({
    tokens,
    references,
    credentials: {
      async get(configId) {
        const stored = await options.configurationService.getStored(configId);
        const credential = stored?.credentials.torbox;
        return credential === undefined ? undefined : { configId, apiKey: credential.apiKey };
      },
    },
    createClient: (apiKey) =>
      options.factories?.torboxClient?.(apiKey, 8_000) ?? createTorboxApiClient({ apiKey }),
    precache,
  });
  const webshareHosts = options.websharePlaybackHosts ?? [];
  const webshare =
    webshareHosts.length === 0
      ? undefined
      : createWebsharePlaybackAssembly({
          baseUrl: options.baseUrl,
          tokens,
          allowedPlaybackHosts: webshareHosts,
          credentials: {
            async get(configId) {
              const stored = await options.configurationService.getStored(configId);
              const credential = stored?.credentials.webshare;
              return credential === undefined ? undefined : { configId, ...credential };
            },
          },
        });
  const runtimes = new Map<string, RuntimeEntry>();

  const playbackResolver: TorboxPlaybackResolver = {
    async inspect(token) {
      const claims = tokens.verify(token);
      if (claims.provider === 'sktorrent') return torboxResolver.inspect(token);
      if (webshare !== undefined) return webshare.resolver.inspect(token);
      throw new PlaybackResolveError('invalid-reference', 'Playback reference is invalid');
    },
    async resolve(token, signal) {
      const claims = tokens.verify(token);
      if (claims.provider === 'sktorrent') return torboxResolver.resolve(token, signal);
      if (webshare !== undefined) return webshare.resolver.resolve(token, signal);
      throw new PlaybackResolveError('invalid-reference', 'Playback reference is invalid');
    },
  };

  return {
    searchStreamsForConfiguration(stored) {
      prune(runtimes, clock());
      const existing = runtimes.get(stored.id);
      if (existing?.updatedAt === stored.updatedAt && existing.expiresAt > clock()) {
        existing.expiresAt = clock() + runtimeTtlMs;
        return existing.search;
      }
      runtimes.delete(stored.id);
      const search = assembleSearch(stored, options, references, tokens, webshare);
      while (runtimes.size >= maximumRuntimes) {
        const oldest = runtimes.keys().next().value;
        if (oldest === undefined) break;
        runtimes.delete(oldest);
      }
      runtimes.set(stored.id, {
        updatedAt: stored.updatedAt,
        search,
        expiresAt: clock() + runtimeTtlMs,
      });
      return search;
    },
    playbackResolver,
    invalidate(configId) {
      runtimes.delete(configId);
    },
  };
};

const assembleSearch = (
  stored: StoredConfiguration,
  options: ProductionIntegrationOptions,
  references: ReturnType<typeof createPlaybackReferenceStore>,
  tokens: ReturnType<typeof createPlayTokenService>,
  webshare: ReturnType<typeof createWebsharePlaybackAssembly> | undefined,
): SearchStreams => {
  const tmdbCredential = stored.credentials.tmdb;
  if (tmdbCredential === undefined) {
    return {
      search() {
        return Promise.reject(new ApplicationError('InvalidConfiguration'));
      },
    };
  }
  const timeoutMs = stored.configuration.advanced?.providerTimeoutMs ?? 8_000;
  const providers: StreamProvider[] = [];
  if (stored.configuration.providers.sktorrent.enabled) {
    const injected = options.factories?.sktorrentProvider?.(stored, timeoutMs);
    const credential = stored.credentials.sktorrent;
    if (injected !== undefined) providers.push(injected);
    else if (credential !== undefined) {
      providers.push(createSktorrentProvider(createSktorrentSource(credential, { timeoutMs })));
    }
  }
  const webshareCredential = stored.credentials.webshare;
  if (stored.configuration.providers.webshare.enabled && webshare !== undefined) {
    const injected = options.factories?.webshareProvider?.(stored, timeoutMs);
    if (injected !== undefined) providers.push(injected);
    else if (webshareCredential !== undefined) {
      const api = createWebshareApiClient({ timeoutMs });
      providers.push(
        createWebshareProvider(
          createWebshareSource(api, createWebshareCredentialService(api, webshareCredential)),
        ),
      );
    }
  }
  const torboxCredential = stored.credentials.torbox;
  const torboxClient =
    torboxCredential === undefined
      ? undefined
      : (options.factories?.torboxClient?.(torboxCredential.apiKey, timeoutMs) ??
        createTorboxApiClient({ apiKey: torboxCredential.apiKey, timeoutMs }));
  return createSearchStreams({
    metadataResolver: new OrderedMetadataResolver([
      createTmdbMetadataSource(
        options.factories?.tmdbClient?.(tmdbCredential.accessToken, timeoutMs) ??
          createTmdbClient({ accessToken: tmdbCredential.accessToken, timeoutMs }),
      ),
    ]),
    providers,
    configuration: stored.configuration,
    ...(torboxClient === undefined
      ? {}
      : {
          cacheEnricher: createTorboxCacheEnricher(torboxClient),
          torboxPlaybackUrl: createTorboxPlaybackUrlFactory({
            baseUrl: options.baseUrl,
            configId: stored.id,
            tokens,
            references,
          }),
        }),
    ...(webshare === undefined || webshareCredential === undefined
      ? {}
      : { websharePlaybackUrl: webshare.urlFactory(stored.id) }),
  });
};

const prune = (runtimes: Map<string, RuntimeEntry>, now: number): void => {
  for (const [id, runtime] of runtimes) if (runtime.expiresAt <= now) runtimes.delete(id);
};

const positiveInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be positive`);
  return value;
};
