import type { TorboxApiClient } from '../providers/torbox/torbox-api-client.js';
import { TorboxTransportError } from '../providers/torbox/torbox-api-client.js';
import type { CacheEnricher } from './search-streams.js';

export type TorboxCacheEnricherOptions = {
  ttlMs?: number;
  batchSize?: number;
  clock?: () => number;
};

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_BATCH_SIZE = 100;

export const createTorboxCacheEnricher = (
  client: TorboxApiClient,
  options: TorboxCacheEnricherOptions = {},
): CacheEnricher => {
  const ttlMs = positiveInteger(options.ttlMs ?? DEFAULT_TTL_MS, 'TorBox cache TTL');
  const batchSize = positiveInteger(
    options.batchSize ?? DEFAULT_BATCH_SIZE,
    'TorBox cache batch size',
  );
  if (batchSize > 100) throw new RangeError('TorBox cache batch size cannot exceed 100');
  const clock = options.clock ?? Date.now;
  const cache = new Map<string, { status: 'cached' | 'uncached'; expiresAt: number }>();

  return async (results, context) => {
    const hashes = [
      ...new Set(
        results.flatMap(({ result }) =>
          result.provider === 'sktorrent' ? [result.infoHash.toLowerCase()] : [],
        ),
      ),
    ];
    const now = clock();
    const missing = hashes.filter((hash) => {
      const entry = cache.get(hash);
      if (entry !== undefined && entry.expiresAt > now) return false;
      cache.delete(hash);
      return true;
    });

    for (let index = 0; index < missing.length; index += batchSize) {
      const batch = missing.slice(index, index + batchSize);
      try {
        const entries = await client.checkCached(batch, context.signal);
        const returned = new Set(entries.map((entry) => entry.hash));
        for (const entry of entries) {
          if (entry.status !== 'unknown') {
            cache.set(entry.hash, { status: entry.status, expiresAt: clock() + ttlMs });
          }
        }
        for (const hash of batch) {
          if (!returned.has(hash)) cache.delete(hash);
        }
      } catch (error) {
        if (
          context.signal.aborted ||
          (error instanceof TorboxTransportError && error.kind === 'cancelled')
        ) {
          context.signal.throwIfAborted();
          throw error;
        }
        for (const hash of batch) cache.delete(hash);
      }
    }

    return results.map((ranked) => {
      if (ranked.result.provider !== 'sktorrent') return ranked;
      return {
        ...ranked,
        result: {
          ...ranked.result,
          cacheStatus: cache.get(ranked.result.infoHash.toLowerCase())?.status ?? 'unknown',
        },
      };
    });
  };
};

const positiveInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be positive`);
  return value;
};
