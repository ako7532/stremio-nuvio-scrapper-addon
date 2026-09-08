import { describe, expect, it, vi } from 'vitest';

import type { TorrentFileStore } from '../../../src/application/torrent-file-store.js';
import type { MediaMetadata } from '../../../src/domain/media.js';
import { isTorrentProviderResult } from '../../../src/domain/release.js';
import type { IndexerBackend } from '../../../src/providers/indexers/indexer-backend.js';
import { IndexerBackendError } from '../../../src/providers/indexers/indexer-backend.js';
import { createIndexersProvider } from '../../../src/providers/indexers/indexers-provider.js';
import type {
  IndexerDiscoveryResult,
  IndexerSearchResult,
  TorznabCapabilities,
} from '../../../src/providers/indexers/indexer-types.js';

const signal = new AbortController().signal;
const context = { signal, correlationId: 'indexers-provider-test' };
const metadata: MediaMetadata = {
  type: 'movie',
  id: 'tt0000011',
  imdbId: 'tt0000011',
  originalTitle: 'Sintel',
  englishTitle: 'Sintel',
  alternativeTitles: [],
  year: 2010,
};
const capabilities: TorznabCapabilities = {
  limits: { maximum: 100, default: 50 },
  modes: {
    search: { available: true, supportedParameters: ['q'] },
    movie: { available: true, supportedParameters: ['q', 'imdbid', 'year'] },
    tvsearch: { available: false, supportedParameters: [] },
  },
  categories: [2000],
};

describe('IndexersProvider', () => {
  it('searches only explicitly selected eligible public torrent indexers', async () => {
    const { backend, capabilitiesMock, searchMock } = fakeBackend({
      discovered: [
        indexer('selected-public'),
        indexer('not-selected'),
        indexer('selected-private', { privacy: 'private' }),
        indexer('selected-unknown', { privacy: 'unknown' }),
        indexer('selected-usenet', { protocol: 'usenet' }),
        indexer('selected-disabled', { enabled: false }),
      ],
    });
    const provider = createIndexersProvider(backend, {
      selectedIndexerIds: [
        'selected-public',
        'selected-private',
        'selected-unknown',
        'selected-usenet',
        'selected-disabled',
      ],
    });

    const results = await provider.searchMetadata?.(metadata, context);

    expect(results).toHaveLength(1);
    expect(results?.[0]).toMatchObject({ provider: 'indexers', infoHash: 'a'.repeat(40) });
    expect(capabilitiesMock).toHaveBeenCalledTimes(1);
    expect(capabilitiesMock).toHaveBeenCalledWith('selected-public', { signal });
    expect(searchMock).toHaveBeenCalled();
    expect(new Set(searchMock.mock.calls.map(([selected]) => selected.backendId))).toEqual(
      new Set(['selected-public']),
    );
  });

  it('keeps successful indexers when another indexer fails and bounds concurrency and queries', async () => {
    let active = 0;
    let maximumActive = 0;
    const discovered = [indexer('first'), indexer('broken'), indexer('third')];
    const { backend, capabilitiesMock, searchMock } = fakeBackend({ discovered });
    capabilitiesMock.mockImplementation(async (id) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active -= 1;
      if (id === 'broken') {
        throw new IndexerBackendError('timeout', 'sanitized timeout');
      }
      return capabilities;
    });
    const provider = createIndexersProvider(backend, {
      selectedIndexerIds: discovered.map(({ backendId }) => backendId),
      indexerConcurrency: 2,
    });

    const results = await provider.searchMetadata?.(metadata, context);

    expect(results).toHaveLength(1);
    expect(maximumActive).toBeLessThanOrEqual(2);
    const callsByIndexer = new Map<string, number>();
    for (const [selected] of searchMock.mock.calls) {
      callsByIndexer.set(selected.backendId, (callsByIndexer.get(selected.backendId) ?? 0) + 1);
    }
    expect(callsByIndexer.get('first')).toBeLessThanOrEqual(4);
    expect(callsByIndexer.get('third')).toBeLessThanOrEqual(4);
    expect(callsByIndexer.has('broken')).toBe(false);
  });

  it('acquires only matched hashless results, stores torrent bytes, and skips acquisition for hashes', async () => {
    const { backend, searchMock, acquireMock } = fakeBackend({
      discovered: [indexer('public')],
    });
    searchMock.mockResolvedValue([
      result('public', 'Unrelated.Movie.2020.1080p.WEB-DL.mkv', { acquisitionReference: 'wrong' }),
      result('public', 'Sintel.2010.1080p.WEB-DL.mkv', { acquisitionReference: 'right' }),
      result('public', 'Sintel.2010.720p.WEB-DL.mkv', { infoHash: 'b'.repeat(40) }),
    ]);
    const torrentBytes = new Uint8Array([1, 2, 3]);
    acquireMock.mockResolvedValue({
      kind: 'file',
      infoHash: 'c'.repeat(40),
      magnetUri: `magnet:?xt=urn:btih:${'c'.repeat(40)}&tr=https%3A%2F%2Ftracker.invalid`,
      torrentFile: torrentBytes,
    });
    const storePut = vi.fn<TorrentFileStore['put']>();
    const store: TorrentFileStore = {
      put: storePut,
      get: vi.fn(),
      deleteNamespace: vi.fn(),
    };
    const provider = createIndexersProvider(backend, {
      selectedIndexerIds: ['public'],
      torrentFiles: { store, namespace: 'configuration-fixture' },
    });

    const results = await provider.searchMetadata?.(metadata, context);

    const torrents = results?.filter(isTorrentProviderResult);
    expect(torrents?.map(({ infoHash }) => infoHash).sort()).toEqual([
      'b'.repeat(40),
      'c'.repeat(40),
    ]);
    expect(acquireMock).toHaveBeenCalledTimes(1);
    expect(acquireMock).toHaveBeenCalledWith('public', 'right', undefined, { signal });
    expect(storePut).toHaveBeenCalledWith('configuration-fixture', 'c'.repeat(40), torrentBytes);
    expect(torrents?.find(({ infoHash }) => infoHash === 'c'.repeat(40))?.magnetUri).toBe(
      `magnet:?xt=urn:btih:${'c'.repeat(40)}`,
    );
  });

  it('deduplicates the same BTIH across indexers and keeps the stronger swarm', async () => {
    const { backend, searchMock } = fakeBackend({
      discovered: [indexer('first'), indexer('second')],
    });
    searchMock.mockImplementation((selected) =>
      Promise.resolve([
        result(selected.backendId, 'Sintel.2010.1080p.WEB-DL.mkv', {
          infoHash: 'd'.repeat(40),
          seeders: selected.backendId === 'first' ? 2 : 20,
        }),
      ]),
    );
    const provider = createIndexersProvider(backend, {
      selectedIndexerIds: ['first', 'second'],
    });

    const results = await provider.searchMetadata?.(metadata, context);

    expect(results).toHaveLength(1);
    expect(results?.[0]).toMatchObject({ infoHash: 'd'.repeat(40), seeders: 20 });
  });

  it('bounds the global acquisition budget and acquisition concurrency', async () => {
    const { backend, searchMock, acquireMock } = fakeBackend({
      discovered: [indexer('public')],
    });
    searchMock.mockResolvedValue(
      Array.from({ length: 5 }, (_, index) =>
        result('public', `Sintel.2010.1080p.WEB-DL.Release${index.toString()}.mkv`, {
          acquisitionReference: `reference-${index.toString()}`,
        }),
      ),
    );
    let active = 0;
    let maximumActive = 0;
    acquireMock.mockImplementation(async (_indexerId, reference) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      const index = Number(reference.at(-1));
      const infoHash = (index + 1).toString(16).repeat(40);
      return { kind: 'magnet', infoHash, magnetUri: `magnet:?xt=urn:btih:${infoHash}` };
    });
    const provider = createIndexersProvider(backend, {
      selectedIndexerIds: ['public'],
      maximumAcquisitions: 3,
      acquisitionConcurrency: 2,
    });

    const results = await provider.searchMetadata?.(metadata, context);

    expect(results).toHaveLength(3);
    expect(acquireMock).toHaveBeenCalledTimes(3);
    expect(maximumActive).toBe(2);
  });

  it('keeps successful hashes and acquisitions when another acquisition fails', async () => {
    const { backend, searchMock, acquireMock } = fakeBackend({
      discovered: [indexer('public')],
    });
    searchMock.mockResolvedValue([
      result('public', 'Sintel.2010.720p.WEB-DL.mkv', { infoHash: 'b'.repeat(40) }),
      result('public', 'Sintel.2010.1080p.WEB-DL.Release1.mkv', {
        acquisitionReference: 'successful',
      }),
      result('public', 'Sintel.2010.1080p.WEB-DL.Release2.mkv', {
        acquisitionReference: 'failed',
      }),
    ]);
    acquireMock.mockImplementation((_indexerId, reference) =>
      reference === 'successful'
        ? Promise.resolve({
            kind: 'magnet',
            infoHash: 'c'.repeat(40),
            magnetUri: `magnet:?xt=urn:btih:${'c'.repeat(40)}`,
          })
        : Promise.reject(new IndexerBackendError('unavailable', 'sanitized acquisition failure')),
    );
    const observer = vi.fn();
    const provider = createIndexersProvider(backend, {
      selectedIndexerIds: ['public'],
      observer,
    });

    const results = await provider.searchMetadata?.(metadata, context);

    expect(
      results
        ?.filter(isTorrentProviderResult)
        .map((candidate) => candidate.infoHash)
        .sort(),
    ).toEqual(['b'.repeat(40), 'c'.repeat(40)]);
    expect(observer).toHaveBeenCalledWith({
      type: 'indexers-provider-summary',
      selectedIndexerCount: 1,
      eligibleIndexerCount: 1,
      queryCount: 2,
      matchedResultCount: 3,
      acquisitionAttemptCount: 2,
      acquisitionFailureCount: 1,
      returnedResultCount: 2,
      correlationId: context.correlationId,
    });
  });

  it('surfaces complete acquisition failure instead of returning an empty success', async () => {
    const { backend, searchMock, acquireMock } = fakeBackend({
      discovered: [indexer('public')],
    });
    searchMock.mockResolvedValue([
      result('public', 'Sintel.2010.1080p.WEB-DL.mkv', {
        acquisitionReference: 'failed',
      }),
    ]);
    acquireMock.mockRejectedValue(
      new IndexerBackendError('timeout', 'sanitized acquisition timeout'),
    );
    const observer = vi.fn();
    const provider = createIndexersProvider(backend, {
      selectedIndexerIds: ['public'],
      observer,
    });

    await expect(provider.searchMetadata?.(metadata, context)).rejects.toMatchObject({
      kind: 'timeout',
    });
    expect(observer).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'indexers-provider-summary',
        acquisitionAttemptCount: 1,
        acquisitionFailureCount: 1,
        returnedResultCount: 0,
      }),
    );
  });

  it('keeps discovery and capabilities caches inside the provider runtime TTL', async () => {
    let now = 1_000;
    const { backend, discoverMock, capabilitiesMock } = fakeBackend({
      discovered: [indexer('public')],
    });
    const provider = createIndexersProvider(backend, {
      selectedIndexerIds: ['public'],
      metadataCacheTtlMs: 100,
      clock: () => now,
    });

    await provider.searchMetadata?.(metadata, context);
    await provider.searchMetadata?.(metadata, context);
    expect(discoverMock).toHaveBeenCalledTimes(1);
    expect(capabilitiesMock).toHaveBeenCalledTimes(1);

    now += 100;
    await provider.searchMetadata?.(metadata, context);
    expect(discoverMock).toHaveBeenCalledTimes(2);
    expect(capabilitiesMock).toHaveBeenCalledTimes(2);
  });

  it('surfaces a backend-wide authentication failure when every selected indexer fails', async () => {
    const { backend, capabilitiesMock } = fakeBackend({
      discovered: [indexer('first'), indexer('second')],
    });
    capabilitiesMock.mockRejectedValue(
      new IndexerBackendError('authentication-failed', 'sanitized authentication failure'),
    );
    const provider = createIndexersProvider(backend, {
      selectedIndexerIds: ['first', 'second'],
    });

    await expect(provider.searchMetadata?.(metadata, context)).rejects.toMatchObject({
      kind: 'authentication-failed',
    });
  });
});

const indexer = (
  backendId: string,
  overrides: Partial<IndexerDiscoveryResult> = {},
): IndexerDiscoveryResult => ({
  backendId,
  name: `Indexer ${backendId}`,
  enabled: true,
  supportsSearch: true,
  protocol: 'torrent',
  privacy: 'public',
  ...overrides,
});

const result = (
  indexerId: string,
  releaseName: string,
  overrides: Partial<IndexerSearchResult> = {},
): IndexerSearchResult => ({
  indexerId,
  indexerName: `Indexer ${indexerId}`,
  releaseName,
  mediaType: 'movie',
  ...overrides,
});

const fakeBackend = (options: { discovered: readonly IndexerDiscoveryResult[] }) => {
  const discoverMock = vi.fn<IndexerBackend['discover']>().mockResolvedValue(options.discovered);
  const capabilitiesMock = vi.fn<IndexerBackend['capabilities']>().mockResolvedValue(capabilities);
  const searchMock = vi.fn<IndexerBackend['search']>().mockImplementation((selected) =>
    Promise.resolve([
      result(selected.backendId, 'Sintel.2010.1080p.WEB-DL.mkv', {
        infoHash: 'a'.repeat(40),
        seeders: 10,
      }),
    ]),
  );
  const acquireMock = vi.fn<IndexerBackend['acquire']>();
  const backend: IndexerBackend = {
    discover: discoverMock,
    capabilities: capabilitiesMock,
    search: searchMock,
    acquire: acquireMock,
  };
  return { backend, discoverMock, capabilitiesMock, searchMock, acquireMock };
};
