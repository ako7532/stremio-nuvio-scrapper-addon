import { describe, expect, it, vi } from 'vitest';

import { createProductionIntegration } from '../../src/application/production-integration.js';
import type { ConfigurationService } from '../../src/application/configuration-service.js';
import type { StoredConfiguration } from '../../src/application/configuration-store.js';
import { defaultConfiguration } from '../../src/domain/configuration-defaults.js';
import type { TmdbClient } from '../../src/metadata/tmdb-client.js';
import { buildServer } from '../../src/http/server.js';
import type { StreamProvider } from '../../src/providers/provider.js';
import type { TorboxApiClient } from '../../src/providers/torbox/torbox-api-client.js';
import { parseRelease } from '../../src/release/release-parser.js';

describe('production integration', () => {
  it('returns fixture-backed movie and episode streams and reuses the runtime caches', async () => {
    const base = configuration();
    const stored: StoredConfiguration = {
      ...base,
      configuration: {
        ...base.configuration,
        advanced: { providerTimeoutMs: 8_000, safeDebug: true },
      },
    };
    const service = configurationService(stored);
    const observer = vi.fn();
    const findByImdbId = vi
      .fn<TmdbClient['findByImdbId']>()
      .mockImplementation((request) =>
        Promise.resolve(
          request.type === 'movie'
            ? { id: 11, originalTitle: 'Sintel', title: 'Sintel', year: 2010 }
            : { id: 22, originalTitle: 'Fixture Show', title: 'Fixture Show', year: 2020 },
        ),
      );
    const tmdb: TmdbClient = {
      validateAuthentication: vi.fn(),
      findByImdbId,
      findByTvdbId: vi.fn(),
      getById: vi.fn(),
      getLocalizedTitle: vi
        .fn()
        .mockImplementation((type) =>
          Promise.resolve(type === 'movie' ? 'Sintel' : 'Fixture Show'),
        ),
      getAlternativeTitles: vi.fn().mockResolvedValue([]),
    };
    const providerSearch = vi.fn<StreamProvider['search']>().mockImplementation((query) => {
      const filename =
        query.type === 'movie'
          ? 'Sintel.2010.1080p.WEB-DL.CZ.HEVC.mkv'
          : 'Fixture.Show.S01E02.1080p.WEB-DL.CZ.HEVC.mkv';
      return Promise.resolve([
        {
          provider: 'sktorrent' as const,
          source: 'torrent' as const,
          id: query.type === 'movie' ? 'movie-result' : 'episode-result',
          title: filename,
          releaseName: filename,
          filename,
          mediaType: query.type,
          providerUrl: 'https://sktorrent.eu/torrent/details.php?id=fixture',
          infoHash: 'a'.repeat(40),
          magnetUri: `magnet:?xt=urn:btih:${'a'.repeat(40)}`,
          cacheStatus: 'unknown' as const,
          parsed: parseRelease(filename),
          seeders: 10,
        },
      ]);
    });
    const provider: StreamProvider = {
      name: 'sktorrent',
      capabilities: {
        search: true,
        source: 'torrent',
        requiresAuthentication: true,
        supportsDirectStreaming: false,
        supportsCacheLookup: false,
      },
      search: providerSearch,
    };
    const integration = createProductionIntegration({
      configurationService: service,
      baseUrl: 'https://addon.example/',
      playbackSecret: new Uint8Array(32).fill(7),
      observer,
      factories: {
        tmdbClient: () => tmdb,
        sktorrentProvider: () => provider,
      },
    });
    const firstRuntime = integration.searchStreamsForConfiguration(stored);
    const secondRuntime = integration.searchStreamsForConfiguration(stored);
    expect(secondRuntime).toBe(firstRuntime);

    const context = { signal: new AbortController().signal, correlationId: 'fixture-request' };
    const movie = await firstRuntime.search({ type: 'movie', id: 'tt0000011' }, context);
    const episode = await firstRuntime.search(
      { type: 'series', id: 'tt0000022', season: 1, episode: 2 },
      context,
    );
    await firstRuntime.search({ type: 'movie', id: 'tt0000011' }, context);

    expect(movie[0]).toMatchObject({ infoHash: 'a'.repeat(40) });
    expect(episode[0]).toMatchObject({
      infoHash: 'a'.repeat(40),
      behaviorHints: { filename: 'Fixture.Show.S01E02.1080p.WEB-DL.CZ.HEVC.mkv' },
    });
    expect(findByImdbId).toHaveBeenCalledTimes(2);
    expect(providerSearch.mock.calls.length).toBeGreaterThan(0);
    expect(observer).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'search-start', correlationId: 'fixture-request' }),
    );

    const server = buildServer({
      configurationService: service,
      searchStreamsForConfiguration: (value) => integration.searchStreamsForConfiguration(value),
      torboxPlaybackResolver: integration.playbackResolver,
    });
    try {
      const response = await server.inject({
        method: 'GET',
        url: `/${stored.id}/stream/movie/tt0000011.json`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        streams: [{ infoHash: 'a'.repeat(40) }],
      });
      expect(response.body).not.toContain('sanitized-tmdb-token');
      expect(response.body).not.toContain('fixture-password');
    } finally {
      await server.close();
    }
  });

  it('requires a per-user TMDB token and rebuilds after updates or invalidation', async () => {
    const stored = configuration();
    const service = configurationService(stored);
    const integration = createProductionIntegration({
      configurationService: service,
      baseUrl: 'https://addon.example/',
      playbackSecret: new Uint8Array(32).fill(9),
      factories: {
        tmdbClient: () => ({
          validateAuthentication: vi.fn(),
          findByImdbId: vi.fn().mockResolvedValue(undefined),
          findByTvdbId: vi.fn().mockResolvedValue(undefined),
          getById: vi.fn(),
          getLocalizedTitle: vi.fn(),
          getAlternativeTitles: vi.fn(),
        }),
      },
    });
    const original = integration.searchStreamsForConfiguration(stored);
    const updated = integration.searchStreamsForConfiguration({
      ...stored,
      updatedAt: '2026-09-06T22:00:00.000Z',
    });
    expect(updated).not.toBe(original);
    integration.invalidate(stored.id);
    expect(integration.searchStreamsForConfiguration(stored)).not.toBe(updated);

    const missingTmdb = integration.searchStreamsForConfiguration({
      ...stored,
      id: 'configuration-without-tmdb-1234',
      credentials: { sktorrent: { username: 'fixture-user', password: 'fixture-password' } },
    });
    await expect(
      missingTmdb.search(
        { type: 'movie', id: 'tt0000011' },
        { signal: new AbortController().signal, correlationId: 'missing-tmdb' },
      ),
    ).rejects.toMatchObject({ kind: 'InvalidConfiguration' });
  });

  it('does not contact TorBox while production stream results are loading', async () => {
    const base = configuration();
    const stored: StoredConfiguration = {
      ...base,
      configuration: {
        ...base.configuration,
        providers: {
          sktorrent: { enabled: true, playbackMode: 'torbox-only' },
          webshare: { enabled: false },
        },
      },
      credentials: {
        ...base.credentials,
        torbox: { apiKey: 'server-held-fixture-key' },
      },
    };
    const checkCached = vi.fn<TorboxApiClient['checkCached']>();
    const listTorrents = vi.fn<TorboxApiClient['listTorrents']>();
    const torbox: TorboxApiClient = {
      validateAuthentication: vi.fn(),
      checkCached,
      listTorrents,
      getTorrent: vi.fn(),
      createTorrent: vi.fn(),
      requestDownloadLink: vi.fn(),
    };
    const filename = 'Sintel.2010.1080p.WEB-DL.CZ.HEVC.mkv';
    const integration = createProductionIntegration({
      configurationService: configurationService(stored),
      baseUrl: 'https://addon.example/',
      playbackSecret: new Uint8Array(32).fill(4),
      factories: {
        tmdbClient: () => ({
          validateAuthentication: vi.fn(),
          findByImdbId: vi
            .fn()
            .mockResolvedValue({ id: 11, originalTitle: 'Sintel', title: 'Sintel', year: 2010 }),
          findByTvdbId: vi.fn(),
          getById: vi.fn(),
          getLocalizedTitle: vi.fn().mockResolvedValue('Sintel'),
          getAlternativeTitles: vi.fn().mockResolvedValue([]),
        }),
        sktorrentProvider: () =>
          provider(
            'sktorrent',
            vi.fn().mockResolvedValue([
              {
                provider: 'sktorrent' as const,
                source: 'torrent' as const,
                id: 'movie-result',
                title: filename,
                releaseName: filename,
                filename,
                mediaType: 'movie' as const,
                providerUrl: 'https://sktorrent.eu/torrent/details.php?id=fixture',
                infoHash: 'a'.repeat(40),
                magnetUri: `magnet:?xt=urn:btih:${'a'.repeat(40)}`,
                cacheStatus: 'unknown' as const,
                parsed: parseRelease(filename),
                seeders: 10,
              },
            ]),
          ),
        torboxClient: () => torbox,
      },
    });

    const streams = await integration
      .searchStreamsForConfiguration(stored)
      .search(
        { type: 'movie', id: 'tt0000011' },
        { signal: new AbortController().signal, correlationId: 'deferred-torbox-production' },
      );

    expect(streams).toHaveLength(1);
    expect(streams[0]).toHaveProperty('url');
    expect(checkCached).not.toHaveBeenCalled();
    expect(listTorrents).not.toHaveBeenCalled();
  });

  it('assembles user providers and server-managed Indexers only with a user TorBox key', () => {
    const base = configuration();
    const service = configurationService(base);
    const search = vi.fn<StreamProvider['search']>().mockResolvedValue([]);
    const sktorrentProvider = vi.fn().mockReturnValue(provider('sktorrent', search));
    const webshareProvider = vi.fn().mockReturnValue(provider('webshare', search));
    const indexersProvider = vi.fn().mockReturnValue(provider('indexers', search));
    const integration = createProductionIntegration({
      configurationService: service,
      baseUrl: 'https://addon.example/',
      playbackSecret: new Uint8Array(32).fill(5),
      indexers: [
        {
          backend: 'prowlarr',
          endpoint: 'https://prowlarr.example/',
          apiKey: 'server-held-indexers-key',
          selectedIndexerIds: ['public-fixture'],
        },
        {
          backend: 'jackett',
          endpoint: 'https://jackett.example/',
          apiKey: 'server-held-jackett-key',
          selectedIndexerIds: [],
        },
      ],
      factories: {
        tmdbClient: () => ({
          validateAuthentication: vi.fn(),
          findByImdbId: vi.fn(),
          findByTvdbId: vi.fn(),
          getById: vi.fn(),
          getLocalizedTitle: vi.fn(),
          getAlternativeTitles: vi.fn(),
        }),
        sktorrentProvider,
        webshareProvider,
        indexersProvider,
      },
    });

    integration.searchStreamsForConfiguration(base);
    expect(sktorrentProvider).toHaveBeenCalledOnce();
    expect(webshareProvider).not.toHaveBeenCalled();
    expect(indexersProvider).not.toHaveBeenCalled();

    integration.searchStreamsForConfiguration({
      ...base,
      updatedAt: '2026-09-06T23:00:00.000Z',
      configuration: {
        ...base.configuration,
        providers: {
          sktorrent: { enabled: false, playbackMode: 'direct-torrent' },
          webshare: { enabled: true },
        },
      },
      credentials: {
        ...base.credentials,
        webshare: { username: 'fixture-user', password: 'fixture-password' },
      },
    });
    expect(sktorrentProvider).toHaveBeenCalledOnce();
    expect(webshareProvider).toHaveBeenCalledOnce();
    expect(indexersProvider).not.toHaveBeenCalled();

    const torboxConfiguration: StoredConfiguration = {
      ...base,
      updatedAt: '2026-09-06T23:01:00.000Z',
      configuration: {
        ...base.configuration,
        providers: {
          sktorrent: { enabled: false, playbackMode: 'direct-torrent' },
          webshare: { enabled: false },
        },
      },
      credentials: { ...base.credentials, torbox: { apiKey: 'user-torbox-key' } },
    };
    integration.searchStreamsForConfiguration(torboxConfiguration);
    expect(sktorrentProvider).toHaveBeenCalledOnce();
    expect(webshareProvider).toHaveBeenCalledOnce();
    expect(indexersProvider).toHaveBeenCalledTimes(2);

    integration.invalidate(base.id);
    integration.searchStreamsForConfiguration(torboxConfiguration);
    expect(indexersProvider).toHaveBeenCalledTimes(4);
  });
});

function configuration(): StoredConfiguration {
  return {
    id: 'configuration-fixture-1234567890',
    configuration: {
      ...defaultConfiguration(),
      providers: {
        sktorrent: { enabled: true, playbackMode: 'direct-torrent' },
        webshare: { enabled: false },
      },
    },
    credentials: {
      tmdb: { accessToken: 'sanitized-tmdb-token' },
      sktorrent: { username: 'fixture-user', password: 'fixture-password' },
    },
    createdAt: '2026-09-06T20:00:00.000Z',
    updatedAt: '2026-09-06T20:00:00.000Z',
  };
}

function configurationService(stored: StoredConfiguration): ConfigurationService {
  return {
    create: vi.fn(),
    get: vi.fn(),
    update: vi.fn(),
    revoke: vi.fn(),
    getStored: vi
      .fn()
      .mockImplementation((id) => Promise.resolve(id === stored.id ? stored : undefined)),
  };
}

function provider(name: StreamProvider['name'], search: StreamProvider['search']): StreamProvider {
  return {
    name,
    capabilities: {
      search: true,
      source: name === 'webshare' ? 'file-hosting' : 'torrent',
      requiresAuthentication: true,
      supportsDirectStreaming: name === 'webshare',
      supportsCacheLookup: false,
    },
    search,
  };
}
