import { describe, expect, it, vi } from 'vitest';

import {
  createCachedMetadataResolver,
  createCachedStreamProvider,
} from '../../src/application/search-cache.js';
import type { CacheEvent } from '../../src/infrastructure/cache-observer.js';
import type { MetadataResolver } from '../../src/metadata/metadata-resolver.js';
import type { StreamProvider } from '../../src/providers/provider.js';

describe('search caches', () => {
  it('caches metadata by complete media identity and reports hits', async () => {
    const resolve = vi.fn<MetadataResolver['resolve']>().mockResolvedValue({
      type: 'series',
      id: 'tt1234567',
      season: 1,
      episode: 2,
      originalTitle: 'Fixture',
      alternativeTitles: [],
    });
    const events: CacheEvent[] = [];
    const cached = createCachedMetadataResolver(
      { resolve },
      { observer: (event) => events.push(event) },
    );
    const context = { signal: new AbortController().signal, correlationId: 'request-1' };

    await cached.resolve({ type: 'series', id: 'tt1234567', season: 1, episode: 2 }, context);
    await cached.resolve({ type: 'series', id: 'tt1234567', season: 1, episode: 2 }, context);
    await cached.resolve({ type: 'series', id: 'tt1234567', season: 1, episode: 3 }, context);

    expect(resolve).toHaveBeenCalledTimes(2);
    expect(events.map(({ hitCount }) => hitCount)).toEqual([0, 1, 0]);
  });

  it('caches only successful provider searches using every relevant query field', async () => {
    const search = vi.fn<StreamProvider['search']>().mockResolvedValue([]);
    const provider: StreamProvider = {
      name: 'webshare',
      capabilities: {
        search: true,
        source: 'file-hosting',
        requiresAuthentication: true,
        supportsDirectStreaming: true,
        supportsCacheLookup: false,
      },
      search,
    };
    const cached = createCachedStreamProvider(provider);
    const context = { signal: new AbortController().signal, correlationId: 'request-2' };
    const query = { type: 'movie' as const, value: 'Fixture', title: 'Fixture', year: 2020 };

    await cached.search(query, context);
    await cached.search(query, context);
    await cached.search({ ...query, year: 2021 }, context);

    expect(search).toHaveBeenCalledTimes(2);
  });
});
