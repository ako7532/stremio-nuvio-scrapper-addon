import type { MediaMetadata, MediaRequest, SearchQuery } from '../domain/media.js';
import type { ProviderResult } from '../domain/release.js';
import { createBoundedTtlCache } from '../infrastructure/bounded-ttl-cache.js';
import { observeCache, type CacheObserver } from '../infrastructure/cache-observer.js';
import type { MetadataResolver } from '../metadata/metadata-resolver.js';
import type { StreamProvider } from '../providers/provider.js';

export type SearchCacheOptions = {
  ttlMs?: number;
  maximumEntries?: number;
  clock?: () => number;
  observer?: CacheObserver;
};

const METADATA_TTL_MS = 6 * 60 * 60 * 1_000;
const PROVIDER_SEARCH_TTL_MS = 2 * 60 * 1_000;
const DEFAULT_MAXIMUM_ENTRIES = 2_000;

export function createCachedMetadataResolver(
  resolver: MetadataResolver,
  options: SearchCacheOptions = {},
): MetadataResolver {
  const cache = createBoundedTtlCache<string, MediaMetadata>({
    ttlMs: options.ttlMs ?? METADATA_TTL_MS,
    maximumEntries: options.maximumEntries ?? DEFAULT_MAXIMUM_ENTRIES,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  return {
    async resolve(request, context) {
      const key = metadataKey(request);
      const cached = cache.get(key);
      observeCache(options.observer, {
        cache: 'metadata',
        hitCount: cached.hit ? 1 : 0,
        missCount: cached.hit ? 0 : 1,
        correlationId: context.correlationId,
      });
      if (cached.hit) return structuredClone(cached.value);
      const value = await resolver.resolve(request, context);
      cache.set(key, structuredClone(value));
      return value;
    },
  };
}

export function createCachedStreamProvider(
  provider: StreamProvider,
  options: SearchCacheOptions = {},
): StreamProvider {
  const cache = createBoundedTtlCache<string, readonly ProviderResult[]>({
    ttlMs: options.ttlMs ?? PROVIDER_SEARCH_TTL_MS,
    maximumEntries: options.maximumEntries ?? DEFAULT_MAXIMUM_ENTRIES,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  return {
    name: provider.name,
    capabilities: provider.capabilities,
    async search(query, context) {
      const cached = cache.get(queryKey(query));
      observeCache(options.observer, {
        cache: 'provider-search',
        provider: provider.name,
        hitCount: cached.hit ? 1 : 0,
        missCount: cached.hit ? 0 : 1,
        correlationId: context.correlationId,
      });
      if (cached.hit) return structuredClone(cached.value);
      const value = await provider.search(query, context);
      cache.set(queryKey(query), structuredClone(value));
      return value;
    },
  };
}

function metadataKey(request: MediaRequest): string {
  return JSON.stringify(
    request.type === 'movie'
      ? [request.type, request.id]
      : [request.type, request.id, request.season, request.episode],
  );
}

function queryKey(query: SearchQuery): string {
  return JSON.stringify(
    query.type === 'movie'
      ? [query.type, query.value, query.title, query.year]
      : [
          query.type,
          query.value,
          query.title,
          query.year,
          query.season,
          query.episode,
          query.seasonPack,
        ],
  );
}
