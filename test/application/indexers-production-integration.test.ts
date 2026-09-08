import { readFile } from 'node:fs/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ConfigurationService } from '../../src/application/configuration-service.js';
import type { StoredConfiguration } from '../../src/application/configuration-store.js';
import { createProductionIntegration } from '../../src/application/production-integration.js';
import { defaultConfiguration } from '../../src/domain/configuration-defaults.js';
import type { TmdbClient } from '../../src/metadata/tmdb-client.js';
import type { StreamProvider } from '../../src/providers/provider.js';
import type { IndexerBackend } from '../../src/providers/indexers/indexer-backend.js';
import { createIndexersProvider } from '../../src/providers/indexers/indexers-provider.js';
import type {
  IndexerDiscoveryResult,
  TorznabCapabilities,
} from '../../src/providers/indexers/indexer-types.js';
import type { TorboxApiClient } from '../../src/providers/torbox/torbox-api-client.js';
import { parseRelease } from '../../src/release/release-parser.js';
import { buildServer } from '../../src/http/server.js';
import { createIndexerEndpointPolicy } from '../../src/security/indexer-endpoint-policy.js';

const GIB = 1_073_741_824;
const selectedHash = '1'.repeat(40);
const torrentBytes = Uint8Array.from([100, 49, 58, 97, 101]);

afterEach(() => vi.unstubAllGlobals());

describe('Indexers production integration', () => {
  it('assembles the configured Prowlarr backend without an injected factory', async () => {
    const stored = configuration({ showUncached: false });
    stored.credentials.indexers = {
      endpoint: 'https://prowlarr.example/base/',
      apiKey: 'indexers-key-fixture',
    };
    if (stored.configuration.providers.indexers !== undefined) {
      stored.configuration.providers.indexers.selectedIndexerIds = ['1'];
    }
    const discoveryFixture = await fixture('prowlarr-indexers.json');
    const capabilitiesFixture = await fixture('caps.xml');
    const searchFixture = await fixture('search.xml');
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(discoveryFixture, 'application/json'))
      .mockResolvedValueOnce(response(capabilitiesFixture, 'application/xml'))
      .mockResolvedValue(response(searchFixture, 'application/rss+xml'));
    vi.stubGlobal('fetch', fetchMock);
    const integration = createProductionIntegration({
      configurationService: configurationService(stored),
      baseUrl: 'https://addon.example/',
      playbackSecret: new Uint8Array(32).fill(4),
      indexerEndpointPolicy: createIndexerEndpointPolicy(['https://prowlarr.example'], {
        lookup: () => Promise.resolve([{ address: '203.0.113.10', family: 4 }]),
        connect: (url, init) => fetchMock(url, init),
      }),
      factories: { tmdbClient: () => tmdbClient('Fixture Movie', 2024) },
    });

    const streams = await integration
      .searchStreamsForConfiguration(stored)
      .search(
        { type: 'movie', id: 'tt0000044' },
        { signal: new AbortController().signal, correlationId: 'configured-indexers-search' },
      );

    expect(streams).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalled();
    expect(
      fetchMock.mock.calls.every(
        ([url]) => !requestUrl(url).toString().includes('indexers-key-fixture'),
      ),
    ).toBe(true);
  });

  it('keeps search and HEAD read-only and uses acquired metainfo on the first selected GET', async () => {
    const stored = configuration({ showUncached: true });
    const backend = indexerBackend({
      search: vi.fn().mockResolvedValue([
        {
          indexerId: 'public-fixture',
          indexerName: 'Public fixture',
          releaseName: 'Sintel.2010.1080p.WEB-DL.mkv',
          mediaType: 'movie',
          acquisitionReference: 'opaque-acquisition-reference',
          seeders: 12,
        },
      ]),
      acquire: vi.fn().mockResolvedValue({
        kind: 'file',
        infoHash: selectedHash,
        magnetUri: `magnet:?xt=urn:btih:${selectedHash}`,
        torrentFile: torrentBytes,
      }),
    });
    const checkCached = vi.fn<TorboxApiClient['checkCached']>().mockResolvedValue([]);
    const listTorrents = vi.fn<TorboxApiClient['listTorrents']>().mockResolvedValue([]);
    const createTorrent = vi.fn<TorboxApiClient['createTorrent']>();
    const createTorrentFile = vi
      .fn<NonNullable<TorboxApiClient['createTorrentFile']>>()
      .mockResolvedValue({ id: 41, hash: selectedHash });
    const requestDownloadLink = vi.fn<TorboxApiClient['requestDownloadLink']>();
    const torbox = torboxClient({
      checkCached,
      listTorrents,
      createTorrent,
      createTorrentFile,
      requestDownloadLink,
    });
    const integration = createProductionIntegration({
      configurationService: configurationService(stored),
      baseUrl: 'https://addon.example/',
      playbackSecret: new Uint8Array(32).fill(6),
      factories: {
        tmdbClient: () => tmdbClient('Sintel', 2010),
        indexersProvider: (_configuration, _timeoutMs, dependencies) =>
          createIndexersProvider(backend, {
            selectedIndexerIds: ['public-fixture'],
            torrentFiles: dependencies.torrentFiles,
          }),
        torboxClient: () => torbox,
      },
    });
    const streams = await integration
      .searchStreamsForConfiguration(stored)
      .search(
        { type: 'movie', id: 'tt0000011' },
        { signal: new AbortController().signal, correlationId: 'indexers-playback-search' },
      );

    expect(streams).toHaveLength(1);
    const playbackUrl = streams[0]?.url;
    expect(playbackUrl).toEqual(expect.stringMatching(/^https:\/\/addon\.example\/play\//u));
    expect(playbackUrl).not.toContain(selectedHash);
    expect(playbackUrl).not.toContain(stored.id);
    expect(playbackUrl).not.toContain('server-held-fixture-key');
    expect(createTorrentFile).not.toHaveBeenCalled();
    expect(createTorrent).not.toHaveBeenCalled();
    expect(requestDownloadLink).not.toHaveBeenCalled();
    expect(checkCached).not.toHaveBeenCalled();
    expect(listTorrents).not.toHaveBeenCalled();

    const server = buildServer({ torboxPlaybackResolver: integration.playbackResolver });
    try {
      const path = playbackPath(playbackUrl);
      const head = await server.inject({ method: 'HEAD', url: path });
      expect(head.statusCode).toBe(204);
      expect(createTorrentFile).not.toHaveBeenCalled();
      expect(createTorrent).not.toHaveBeenCalled();
      expect(requestDownloadLink).not.toHaveBeenCalled();
      expect(listTorrents).not.toHaveBeenCalled();

      const get = await server.inject({ method: 'GET', url: path });
      expect(get.statusCode).toBe(302);
      expect(listTorrents).toHaveBeenCalledOnce();
      expect(createTorrentFile).toHaveBeenCalledOnce();
      expect(createTorrentFile).toHaveBeenCalledWith(torrentBytes, expect.any(AbortSignal));
      expect(createTorrent).not.toHaveBeenCalled();
      expect(requestDownloadLink).not.toHaveBeenCalled();

      integration.invalidate(stored.id);
      const invalidatedHead = await server.inject({ method: 'HEAD', url: path });
      expect(invalidatedHead.statusCode).not.toBe(204);
    } finally {
      await server.close();
    }
  });

  it('discovers following Indexers episodes through metadata and applies precache budgets only after GET', async () => {
    const stored = configuration({
      showUncached: false,
      precacheCount: 4,
      precacheLimits: {
        minimumSeeders: 5,
        maximumTorrentSizeBytes: 2 * GIB,
        maximumTotalSizeBytes: 3 * GIB,
      },
    });
    let activeSearches = 0;
    let maximumActiveSearches = 0;
    const searchedEpisodes: number[] = [];
    const searchMetadata = vi.fn<NonNullable<StreamProvider['searchMetadata']>>(
      async (metadata) => {
        if (metadata.type !== 'series') return [];
        searchedEpisodes.push(metadata.episode);
        activeSearches += 1;
        maximumActiveSearches = Math.max(maximumActiveSearches, activeSearches);
        await new Promise((resolve) => setTimeout(resolve, 1));
        activeSearches -= 1;
        const episode = metadata.episode;
        const actualEpisode = episode === 3 ? 30 : episode;
        const sizeBytes = episode === 4 ? 3 * GIB : episode === 5 ? 2 * GIB : GIB;
        const hash = episode.toString(16).repeat(40);
        const releaseName = `Fixture.Show.S01E${actualEpisode.toString().padStart(2, '0')}.1080p.WEB-DL.mkv`;
        return [
          {
            provider: 'indexers',
            source: 'torrent',
            id: `public-fixture:${hash}`,
            title: releaseName,
            releaseName,
            filename: releaseName,
            mediaType: 'series',
            season: 1,
            episode: actualEpisode,
            sizeBytes,
            seeders: 10,
            providerUrl: 'https://indexers.invalid/public-fixture',
            parsed: parseRelease(releaseName),
            infoHash: hash,
            magnetUri: `magnet:?xt=urn:btih:${hash}`,
            cacheStatus: 'unknown',
          },
        ];
      },
    );
    const indexers: StreamProvider = {
      name: 'indexers',
      capabilities: {
        search: true,
        source: 'torrent',
        requiresAuthentication: true,
        supportsDirectStreaming: false,
        supportsCacheLookup: false,
      },
      search: vi.fn().mockResolvedValue([]),
      searchMetadata,
    };
    const checkCached = vi
      .fn<TorboxApiClient['checkCached']>()
      .mockImplementation((hashes: readonly string[]) =>
        Promise.resolve(hashes.map((hash) => ({ hash, status: 'uncached' as const }))),
      );
    const listTorrents = vi.fn<TorboxApiClient['listTorrents']>().mockResolvedValue([
      {
        id: 10,
        hash: selectedHash,
        name: 'Fixture Show S01E01',
        downloadState: 'cached',
        files: [{ id: 11, name: 'Fixture.Show.S01E01.1080p.WEB-DL.mkv', sizeBytes: GIB }],
      },
    ]);
    const createTorrent = vi.fn<TorboxApiClient['createTorrent']>().mockResolvedValue({ id: 50 });
    const createTorrentFile = vi.fn<NonNullable<TorboxApiClient['createTorrentFile']>>();
    const requestDownloadLink = vi
      .fn<TorboxApiClient['requestDownloadLink']>()
      .mockResolvedValue('https://cdn.torbox.app/fixture-video');
    const torbox = torboxClient({
      listTorrents,
      checkCached,
      createTorrent,
      createTorrentFile,
      requestDownloadLink,
    });
    const integration = createProductionIntegration({
      configurationService: configurationService(stored),
      baseUrl: 'https://addon.example/',
      playbackSecret: new Uint8Array(32).fill(8),
      factories: {
        tmdbClient: () => tmdbClient('Fixture Show', 2020),
        indexersProvider: () => indexers,
        torboxClient: () => torbox,
      },
    });
    const streams = await integration
      .searchStreamsForConfiguration(stored)
      .search(
        { type: 'series', id: 'tt0000022', season: 1, episode: 1 },
        { signal: new AbortController().signal, correlationId: 'indexers-precache-search' },
      );

    expect(searchedEpisodes).toEqual([1]);
    expect(createTorrentFile).not.toHaveBeenCalled();
    expect(createTorrent).not.toHaveBeenCalled();
    expect(requestDownloadLink).not.toHaveBeenCalled();
    expect(checkCached).not.toHaveBeenCalled();

    const server = buildServer({ torboxPlaybackResolver: integration.playbackResolver });
    try {
      const response = await server.inject({ method: 'GET', url: playbackPath(streams[0]?.url) });
      expect(response.statusCode).toBe(302);
      await vi.waitFor(() => {
        expect(createTorrent).toHaveBeenCalledTimes(2);
      });
    } finally {
      await server.close();
    }

    expect([...searchedEpisodes].sort((left, right) => left - right)).toEqual([1, 2, 3, 4, 5]);
    expect(maximumActiveSearches).toBeLessThanOrEqual(2);
    expect(createTorrent.mock.calls.map(([magnet]) => magnet)).toEqual([
      `magnet:?xt=urn:btih:${'2'.repeat(40)}`,
      `magnet:?xt=urn:btih:${'5'.repeat(40)}`,
    ]);
    expect(requestDownloadLink).toHaveBeenCalledOnce();
  });
});

function configuration(
  torboxOverrides: Partial<StoredConfiguration['configuration']['torbox']>,
): StoredConfiguration {
  const defaults = defaultConfiguration();
  return {
    id: 'configuration-indexers-fixture-1234',
    configuration: {
      ...defaults,
      providers: {
        sktorrent: { enabled: false, playbackMode: 'direct-torrent' },
        webshare: { enabled: false },
        indexers: {
          enabled: true,
          backend: 'prowlarr',
          selectedIndexerIds: ['public-fixture'],
        },
      },
      torbox: { ...defaults.torbox, ...torboxOverrides },
    },
    credentials: {
      tmdb: { accessToken: 'sanitized-tmdb-token' },
      torbox: { apiKey: 'server-held-fixture-key' },
    },
    createdAt: '2026-09-08T10:00:00.000Z',
    updatedAt: '2026-09-08T10:00:00.000Z',
  };
}

function configurationService(stored: StoredConfiguration): ConfigurationService {
  return {
    create: vi.fn(),
    get: vi.fn(),
    update: vi.fn(),
    revoke: vi.fn(),
    getStored: vi.fn().mockResolvedValue(stored),
  };
}

function tmdbClient(title: string, year: number): TmdbClient {
  return {
    validateAuthentication: vi.fn(),
    findByImdbId: vi.fn().mockResolvedValue({ id: 1, originalTitle: title, title, year }),
    findByTvdbId: vi.fn(),
    getById: vi.fn(),
    getLocalizedTitle: vi.fn().mockResolvedValue(title),
    getAlternativeTitles: vi.fn().mockResolvedValue([]),
  };
}

function indexerBackend(overrides: {
  search: IndexerBackend['search'];
  acquire: IndexerBackend['acquire'];
}): IndexerBackend {
  const discovered: IndexerDiscoveryResult = {
    backendId: 'public-fixture',
    name: 'Public fixture',
    enabled: true,
    supportsSearch: true,
    protocol: 'torrent',
    privacy: 'public',
  };
  const capabilities: TorznabCapabilities = {
    limits: { maximum: 100, default: 50 },
    modes: {
      search: { available: true, supportedParameters: ['q'] },
      movie: { available: true, supportedParameters: ['q', 'imdbid', 'year'] },
      tvsearch: { available: true, supportedParameters: ['q', 'season', 'ep'] },
    },
    categories: [2000, 5000],
  };
  return {
    discover: vi.fn().mockResolvedValue([discovered]),
    capabilities: vi.fn().mockResolvedValue(capabilities),
    search: overrides.search,
    acquire: overrides.acquire,
  };
}

function torboxClient(overrides: Partial<TorboxApiClient>): TorboxApiClient {
  return {
    validateAuthentication: vi.fn(),
    checkCached: vi.fn().mockResolvedValue([]),
    listTorrents: vi.fn().mockResolvedValue([]),
    getTorrent: vi.fn(),
    createTorrent: vi.fn(),
    createTorrentFile: vi.fn(),
    requestDownloadLink: vi.fn(),
    ...overrides,
  };
}

function playbackPath(value: string | undefined): string {
  if (value === undefined) throw new TypeError('Expected an opaque Indexers playback URL');
  const url = new URL(value);
  return `${url.pathname}${url.search}`;
}

const fixture = (name: string): Promise<string> =>
  readFile(new URL(`../fixtures/indexers/${name}`, import.meta.url), 'utf8');

const response = (body: string, contentType: string): Response =>
  new Response(body, { status: 200, headers: { 'content-type': contentType } });

const requestUrl = (value: string | URL | Request | undefined): URL => {
  if (value instanceof URL) return value;
  if (value instanceof Request) return new URL(value.url);
  if (typeof value === 'string') return new URL(value);
  throw new TypeError('Expected request URL');
};
