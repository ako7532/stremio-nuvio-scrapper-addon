import { describe, expect, it, vi } from 'vitest';

import { createTorboxCacheEnricher } from '../../src/application/torbox-cache-enricher.js';
import type { CacheObserver } from '../../src/infrastructure/cache-observer.js';
import type { RankedResult, TorrentProviderResult } from '../../src/domain/release.js';
import type { TorboxApiClient } from '../../src/providers/torbox/torbox-api-client.js';

describe('TorBox cache enricher', () => {
  it('deduplicates hashes, batches lookups, and uses its short-lived cache', async () => {
    let now = 1_000;
    const checkCached = vi
      .fn<TorboxApiClient['checkCached']>()
      .mockImplementation((hashes) =>
        Promise.resolve(
          hashes.map((hash) => ({ hash, status: hash.startsWith('a') ? 'cached' : 'uncached' })),
        ),
      );
    const enricher = createTorboxCacheEnricher(client({ checkCached }), {
      batchSize: 2,
      ttlMs: 100,
      clock: () => now,
    });
    const results = [ranked('a'), ranked('a'), ranked('b'), ranked('c')];
    const context = { signal: new AbortController().signal, correlationId: 'request-1' };

    const first = await enricher(results, context);
    const second = await enricher(results, context);

    expect(
      first.map(({ result }) => result.provider === 'sktorrent' && result.cacheStatus),
    ).toEqual(['cached', 'cached', 'uncached', 'uncached']);
    expect(second).toEqual(first);
    expect(checkCached).toHaveBeenCalledTimes(2);
    expect(checkCached.mock.calls.map(([hashes]) => hashes)).toEqual([
      ['a'.repeat(40), 'b'.repeat(40)],
      ['c'.repeat(40)],
    ]);

    now = 1_100;
    await enricher(results, context);
    expect(checkCached).toHaveBeenCalledTimes(4);
  });

  it('leaves a failed or ambiguous batch unknown', async () => {
    const checkCached = vi
      .fn<TorboxApiClient['checkCached']>()
      .mockRejectedValue(new Error('down'));
    const enricher = createTorboxCacheEnricher(client({ checkCached }));

    const [value] = await enricher([ranked('a')], {
      signal: new AbortController().signal,
      correlationId: 'request-2',
    });

    expect(value?.result).toMatchObject({ cacheStatus: 'unknown' });
  });

  it('enriches every torrent source, including Indexers', async () => {
    const checkCached = vi
      .fn<TorboxApiClient['checkCached']>()
      .mockResolvedValue([{ hash: 'a'.repeat(40), status: 'cached' }]);
    const enricher = createTorboxCacheEnricher(client({ checkCached }));

    const [value] = await enricher([ranked('a', 'indexers')], {
      signal: new AbortController().signal,
      correlationId: 'request-indexers',
    });

    expect(value?.result).toMatchObject({ provider: 'indexers', cacheStatus: 'cached' });
    expect(checkCached).toHaveBeenCalledWith(['a'.repeat(40)], expect.any(AbortSignal));
  });

  it('bounds retained cache entries', async () => {
    const checkCached = vi
      .fn<TorboxApiClient['checkCached']>()
      .mockImplementation((hashes) =>
        Promise.resolve(hashes.map((hash) => ({ hash, status: 'cached' as const }))),
      );
    const enricher = createTorboxCacheEnricher(client({ checkCached }), { maximumEntries: 2 });
    const context = { signal: new AbortController().signal, correlationId: 'request-3' };

    await enricher([ranked('a'), ranked('b'), ranked('c')], context);
    await enricher([ranked('a')], context);

    expect(checkCached).toHaveBeenCalledTimes(2);
    expect(checkCached.mock.calls[1]?.[0]).toEqual(['a'.repeat(40)]);
  });

  it('reports aggregate cache hits without hashes', async () => {
    const observer = vi.fn<CacheObserver>();
    const checkCached = vi
      .fn<TorboxApiClient['checkCached']>()
      .mockImplementation((hashes) =>
        Promise.resolve(hashes.map((hash) => ({ hash, status: 'cached' as const }))),
      );
    const enricher = createTorboxCacheEnricher(client({ checkCached }), { observer });
    const context = { signal: new AbortController().signal, correlationId: 'request-4' };

    await enricher([ranked('a')], context);
    await enricher([ranked('a')], context);

    expect(observer).toHaveBeenLastCalledWith({
      cache: 'torbox-status',
      provider: 'torbox',
      correlationId: 'request-4',
      hitCount: 1,
      missCount: 0,
    });
    expect(JSON.stringify(observer.mock.calls)).not.toContain('aaaaaaaaaaaaaaaa');
  });
});

const ranked = (
  prefix: string,
  provider: TorrentProviderResult['provider'] = 'sktorrent',
): RankedResult => ({
  result: {
    provider,
    source: 'torrent',
    id: prefix,
    title: 'Fixture',
    releaseName: 'Fixture.1080p.mkv',
    mediaType: 'movie',
    providerUrl: 'https://indexer-backend.example/release',
    infoHash: prefix.repeat(40),
    magnetUri: `magnet:?xt=urn:btih:${prefix.repeat(40)}`,
    cacheStatus: 'unknown',
  } satisfies TorrentProviderResult,
  matchScore: 100,
  rankValues: {},
});

const client = (overrides: Partial<TorboxApiClient>): TorboxApiClient => ({
  validateAuthentication: vi.fn(),
  checkCached: vi.fn(),
  listTorrents: vi.fn(),
  getTorrent: vi.fn(),
  createTorrent: vi.fn(),
  requestDownloadLink: vi.fn(),
  ...overrides,
});
