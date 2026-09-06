import { createBoundedTtlCache } from '../../infrastructure/bounded-ttl-cache.js';
import { observeCache, type CacheObserver } from '../../infrastructure/cache-observer.js';
import type { SktorrentSource } from './sktorrent-source.js';
import type { SktorrentDetail } from './sktorrent-types.js';

export type SktorrentSourceCacheOptions = {
  detailTtlMs?: number;
  maximumDetails?: number;
  clock?: () => number;
  observer?: CacheObserver;
};

const DEFAULT_DETAIL_TTL_MS = 10 * 60 * 1_000;
const DEFAULT_MAXIMUM_DETAILS = 2_000;

export function createCachedSktorrentSource(
  source: SktorrentSource,
  options: SktorrentSourceCacheOptions = {},
): SktorrentSource {
  const details = createBoundedTtlCache<string, SktorrentDetail>({
    ttlMs: options.detailTtlMs ?? DEFAULT_DETAIL_TTL_MS,
    maximumEntries: options.maximumDetails ?? DEFAULT_MAXIMUM_DETAILS,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  return {
    ...(source.validateAuthentication === undefined
      ? {}
      : { validateAuthentication: source.validateAuthentication.bind(source) }),
    search: source.search.bind(source),
    async getDetail(result, signal) {
      const key = `${result.id}:${result.detailUrl}`;
      const cached = details.get(key);
      observeCache(options.observer, {
        cache: 'sktorrent-detail',
        provider: 'sktorrent',
        hitCount: cached.hit ? 1 : 0,
        missCount: cached.hit ? 0 : 1,
      });
      if (cached.hit) return structuredClone(cached.value);
      const detail = await source.getDetail(result, signal);
      details.set(key, structuredClone(detail));
      return detail;
    },
    downloadTorrent: source.downloadTorrent.bind(source),
  };
}
