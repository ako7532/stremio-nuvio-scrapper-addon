import { describe, expect, it, vi } from 'vitest';

import { createSearchStreams } from '../../src/application/search-streams.js';
import type { SearchObserver } from '../../src/application/search-observability.js';
import type { UserConfiguration } from '../../src/domain/configuration.js';
import type {
  FileProviderResult,
  RankedResult,
  TorrentProviderResult,
} from '../../src/domain/release.js';
import type { MetadataResolver } from '../../src/metadata/metadata-resolver.js';
import type { StreamProvider } from '../../src/providers/provider.js';
import { parseRelease } from '../../src/release/release-parser.js';
import type { TorboxPlaybackUrlFactory } from '../../src/http/stream-formatter.js';

const configuration: UserConfiguration = {
  providers: {
    sktorrent: { enabled: true, playbackMode: 'direct-torrent' },
    webshare: { enabled: true },
  },
  filters: {
    resolutions: ['1080p'],
    sources: ['web-dl'],
    videoCodecs: ['hevc'],
    dynamicRanges: ['unknown'],
    minimumSeeders: 0,
    includeTerms: [],
    excludeTerms: [],
  },
  languages: {
    mode: 'fallback',
    audio: { preferred: ['cs'], allowed: ['en'], excluded: [] },
    subtitles: { preferred: ['cs'], allowed: ['en'], excluded: [] },
  },
  ranking: ['language', 'resolution'],
  limits: { total: 5, perResolution: { '1080p': 2 } },
  torbox: { showUncached: false, precacheCount: 0 },
  display: { mode: 'compact' },
};

describe('SearchStreams', () => {
  it('finds one uncached SKTorrent candidate for each following episode in order', async () => {
    const metadataResolver: MetadataResolver = {
      resolve: vi.fn().mockResolvedValue({
        type: 'series',
        id: 'tmdb:58141',
        season: 17,
        episode: 1,
        originalTitle: 'Farma',
        alternativeTitles: [],
        year: 2011,
      }),
    };
    const searchedEpisodes: number[] = [];
    const provider: StreamProvider = {
      name: 'sktorrent',
      capabilities: {
        search: true,
        source: 'torrent',
        requiresAuthentication: true,
        supportsDirectStreaming: false,
        supportsCacheLookup: false,
      },
      search(query) {
        const episode = Number(/E(\d{2,3})/iu.exec(query.value)?.[1]);
        searchedEpisodes.push(episode);
        return Promise.resolve([seriesTorrentResult(episode)]);
      },
    };
    const searchStreams = createSearchStreams({
      metadataResolver,
      providers: [provider],
      configuration: {
        ...configuration,
        providers: {
          ...configuration.providers,
          sktorrent: { enabled: true, playbackMode: 'torbox-only' },
        },
        torbox: { showUncached: true, precacheCount: 3 },
      },
      cacheEnricher: (results) =>
        Promise.resolve(
          results.map((candidate) => ({
            ...candidate,
            result:
              candidate.result.provider === 'sktorrent'
                ? { ...candidate.result, cacheStatus: 'uncached' as const }
                : candidate.result,
          })),
        ),
      torboxPlaybackUrl: () => 'https://addon.example/download/opaque-reference/video.mp4',
      caching: false,
      providerExecutionPolicy: false,
    });

    const candidates = await searchStreams.findNextEpisodeCandidates?.(
      { type: 'series', id: 'tmdb:58141', season: 17, episode: 1 },
      3,
      { signal: new AbortController().signal, correlationId: 'precache' },
    );

    expect(candidates?.map(({ result }) => result.episode)).toEqual([2, 3, 4]);
    expect([...new Set(searchedEpisodes)].sort((left, right) => left - right)).toEqual([2, 3, 4]);
  });

  it('isolates provider failures and runs matching, deduplication, filters, enrichment, ranking, limits, and formatting', async () => {
    const metadataResolver: MetadataResolver = {
      resolve: vi.fn().mockResolvedValue({
        type: 'movie',
        id: 'tt0807840',
        originalTitle: 'Sintel',
        alternativeTitles: [],
        year: 2010,
      }),
    };
    const failedSearch = vi.fn().mockRejectedValue(new Error('provider unavailable'));
    const failedProvider: StreamProvider = {
      name: 'sktorrent',
      capabilities: {
        search: true,
        source: 'torrent',
        requiresAuthentication: true,
        supportsDirectStreaming: false,
        supportsCacheLookup: false,
      },
      search: failedSearch,
    };
    const result = webshareResult();
    const successfulSearch = vi.fn().mockResolvedValue([result]);
    const successfulProvider: StreamProvider = {
      name: 'webshare',
      capabilities: {
        search: true,
        source: 'file-hosting',
        requiresAuthentication: true,
        supportsDirectStreaming: true,
        supportsCacheLookup: false,
      },
      search: successfulSearch,
    };
    const cacheEnricher = vi.fn((results: readonly RankedResult[]) => Promise.resolve(results));
    const observer = vi.fn<SearchObserver>();
    const searchStreams = createSearchStreams({
      metadataResolver,
      providers: [failedProvider, successfulProvider],
      configuration,
      cacheEnricher,
      websharePlaybackUrl: () => 'https://addon.example/play/opaque-token',
      observer,
    });

    const streams = await searchStreams.search(
      { type: 'movie', id: 'tt0807840' },
      { signal: new AbortController().signal, correlationId: 'request-1' },
    );

    expect(failedSearch).toHaveBeenCalled();
    expect(successfulSearch).toHaveBeenCalled();
    expect(cacheEnricher).toHaveBeenCalledOnce();
    expect(cacheEnricher.mock.calls[0]?.[0]).toHaveLength(1);
    expect(streams).toEqual([
      expect.objectContaining({
        name: '☁️ Webshare • 1080p',
        url: 'https://addon.example/play/opaque-token',
        behaviorHints: { filename: result.filename },
      }),
    ]);
    expect(observer).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'provider-error',
        provider: 'sktorrent',
        category: 'ProviderUnavailable',
        correlationId: 'request-1',
      }),
    );
    expect(observer).toHaveBeenCalledWith({
      type: 'search-start',
      mediaType: 'movie',
      mediaId: 'tt0807840',
      correlationId: 'request-1',
    });
    expect(observer).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'provider-stage-complete',
        provider: 'webshare',
        stage: 'precise',
        queries: ['Sintel 2010'],
        rawResultCount: 1,
        correlationId: 'request-1',
      }),
    );
    expect(observer).toHaveBeenCalledWith({
      type: 'matching-complete',
      acceptedCount: 1,
      rejectedCount: 0,
      rejectionReasons: {},
      correlationId: 'request-1',
    });
    expect(observer).toHaveBeenCalledWith({
      type: 'filtering-complete',
      deduplicatedCount: 1,
      acceptedCount: 1,
      rejectionReasons: {},
      correlationId: 'request-1',
    });
    expect(observer).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'cache-enrichment-complete',
        cachedCount: 0,
        uncachedCount: 0,
        unknownCount: 0,
        notApplicableCount: 1,
        correlationId: 'request-1',
      }),
    );
    expect(observer).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'search-complete',
        returnedResultCount: 1,
        correlationId: 'request-1',
      }),
    );
    expect(JSON.stringify(observer.mock.calls)).not.toContain('5m56ZO4cb6');
    expect(JSON.stringify(observer.mock.calls)).not.toContain('opaque-token');
  });

  it('keeps TorBox search side-effect free and hides unknown or disabled uncached results', async () => {
    const metadataResolver: MetadataResolver = {
      resolve: vi.fn().mockResolvedValue({
        type: 'movie',
        id: 'tt0807840',
        originalTitle: 'Sintel',
        alternativeTitles: [],
        year: 2010,
      }),
    };
    const cached = torrentResult('a');
    const uncached = torrentResult('b');
    const unknown = torrentResult('c');
    const provider: StreamProvider = {
      name: 'sktorrent',
      capabilities: {
        search: true,
        source: 'torrent',
        requiresAuthentication: true,
        supportsDirectStreaming: false,
        supportsCacheLookup: false,
      },
      search: vi.fn().mockResolvedValue([cached, uncached, unknown]),
    };
    const cacheEnricher = vi.fn((results: readonly RankedResult[]) =>
      Promise.resolve(
        results.map((ranked) => ({
          ...ranked,
          result: {
            ...ranked.result,
            cacheStatus:
              ranked.result.id === 'a'
                ? ('cached' as const)
                : ranked.result.id === 'b'
                  ? ('uncached' as const)
                  : ('unknown' as const),
          },
        })),
      ),
    );
    const torboxPlaybackUrl = vi
      .fn<TorboxPlaybackUrlFactory>()
      .mockReturnValue('https://addon.example/play/opaque-token');
    const torboxConfiguration: UserConfiguration = {
      ...configuration,
      providers: {
        ...configuration.providers,
        sktorrent: { enabled: true, playbackMode: 'torbox-only' },
        webshare: { enabled: false },
      },
      torbox: { showUncached: false, precacheCount: 2 },
    };
    const searchStreams = createSearchStreams({
      metadataResolver,
      providers: [provider],
      configuration: torboxConfiguration,
      cacheEnricher,
      torboxPlaybackUrl,
    });

    const streams = await searchStreams.search(
      { type: 'movie', id: 'tt0807840' },
      { signal: new AbortController().signal, correlationId: 'request-torbox' },
    );

    expect(streams).toHaveLength(1);
    expect(streams[0]).toMatchObject({ url: 'https://addon.example/play/opaque-token' });
    expect(streams[0]).not.toHaveProperty('infoHash');
    expect(torboxPlaybackUrl).toHaveBeenCalledOnce();
    expect(torboxPlaybackUrl.mock.calls[0]?.[1]).toEqual({ type: 'movie', id: 'tt0807840' });
    expect(torboxPlaybackUrl.mock.calls[0]?.[2]).toHaveLength(3);
  });

  it('defers TorBox cache lookup and keeps an unknown result available until playback', async () => {
    const metadataResolver: MetadataResolver = {
      resolve: vi.fn().mockResolvedValue({
        type: 'movie',
        id: 'tt0807840',
        originalTitle: 'Sintel',
        alternativeTitles: [],
        year: 2010,
      }),
    };
    const provider: StreamProvider = {
      name: 'sktorrent',
      capabilities: {
        search: true,
        source: 'torrent',
        requiresAuthentication: true,
        supportsDirectStreaming: false,
        supportsCacheLookup: false,
      },
      search: vi.fn().mockResolvedValue([torrentResult('a')]),
    };
    const cacheEnricher = vi.fn((results: readonly RankedResult[]) => Promise.resolve(results));
    const observer = vi.fn<SearchObserver>();
    const searchStreams = createSearchStreams({
      metadataResolver,
      providers: [provider],
      configuration: {
        ...configuration,
        providers: {
          ...configuration.providers,
          sktorrent: { enabled: true, playbackMode: 'torbox-only' },
          webshare: { enabled: false },
        },
      },
      cacheEnricher,
      deferCacheEnrichmentUntilPlayback: true,
      torboxPlaybackUrl: () => 'https://addon.example/play/opaque-token',
      observer,
      caching: false,
      providerExecutionPolicy: false,
    });

    const streams = await searchStreams.search(
      { type: 'movie', id: 'tt0807840' },
      { signal: new AbortController().signal, correlationId: 'deferred-torbox' },
    );

    expect(streams).toHaveLength(1);
    expect(cacheEnricher).not.toHaveBeenCalled();
    expect(observer).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'cache-enrichment-complete', deferred: true }),
    );
  });

  it('runs a metadata-aware Indexers provider once and requires TorBox playback', async () => {
    const resolvedMetadata = {
      type: 'movie' as const,
      id: 'tt0807840',
      imdbId: 'tt0807840',
      originalTitle: 'Sintel',
      alternativeTitles: [],
      year: 2010,
    };
    const metadataResolver: MetadataResolver = {
      resolve: vi.fn().mockResolvedValue(resolvedMetadata),
    };
    const querySearch = vi.fn<StreamProvider['search']>().mockRejectedValue(new Error('unused'));
    const searchMetadata = vi
      .fn()
      .mockResolvedValue([{ ...torrentResult('i'), provider: 'indexers' as const }]);
    const provider: StreamProvider = {
      name: 'indexers',
      capabilities: {
        search: true,
        source: 'torrent',
        requiresAuthentication: true,
        supportsDirectStreaming: false,
        supportsCacheLookup: false,
      },
      search: querySearch,
      searchMetadata,
    };
    const indexersConfiguration: UserConfiguration = {
      ...configuration,
      providers: {
        sktorrent: { enabled: false, playbackMode: 'direct-torrent' },
        webshare: { enabled: false },
      },
    };
    const withoutTorbox = createSearchStreams({
      metadataResolver,
      providers: [provider],
      configuration: indexersConfiguration,
      caching: false,
      providerExecutionPolicy: false,
    });

    await expect(
      withoutTorbox.search(
        { type: 'movie', id: 'tt0807840' },
        { signal: new AbortController().signal, correlationId: 'indexers-without-torbox' },
      ),
    ).resolves.toEqual([]);
    expect(searchMetadata).toHaveBeenCalledOnce();
    expect(searchMetadata).toHaveBeenCalledWith(
      resolvedMetadata,
      expect.objectContaining({ correlationId: 'indexers-without-torbox' }),
    );
    expect(querySearch).not.toHaveBeenCalled();

    const withTorbox = createSearchStreams({
      metadataResolver,
      providers: [provider],
      configuration: indexersConfiguration,
      deferCacheEnrichmentUntilPlayback: true,
      cacheEnricher: vi.fn(),
      torboxPlaybackUrl: () => 'https://addon.example/play/opaque-indexers-reference',
      caching: false,
      providerExecutionPolicy: false,
    });
    const streams = await withTorbox.search(
      { type: 'movie', id: 'tt0807840' },
      { signal: new AbortController().signal, correlationId: 'indexers-with-torbox' },
    );
    expect(streams).toHaveLength(1);
    expect(streams[0]).toHaveProperty(
      'url',
      'https://addon.example/play/opaque-indexers-reference',
    );
    expect(searchMetadata).toHaveBeenCalledTimes(2);
    expect(querySearch).not.toHaveBeenCalled();
  });

  it('runs bounded movie fallback queries only when precise queries return no results', async () => {
    const metadataResolver: MetadataResolver = {
      resolve: vi.fn().mockResolvedValue({
        type: 'movie',
        id: 'tt0000001',
        originalTitle: 'Example Movie',
        alternativeTitles: [],
        year: 2020,
      }),
    };
    const emptySearch = vi.fn<StreamProvider['search']>().mockResolvedValue([]);
    const fallbackProvider: StreamProvider = {
      name: 'sktorrent',
      capabilities: {
        search: true,
        source: 'torrent',
        requiresAuthentication: true,
        supportsDirectStreaming: false,
        supportsCacheLookup: false,
      },
      search: emptySearch,
    };
    const searchStreams = createSearchStreams({
      metadataResolver,
      providers: [fallbackProvider],
      configuration: {
        ...configuration,
        providers: { ...configuration.providers, webshare: { enabled: false } },
      },
      caching: false,
    });

    await searchStreams.search(
      { type: 'movie', id: 'tt0000001' },
      { signal: new AbortController().signal, correlationId: 'fallback-test' },
    );

    expect(emptySearch.mock.calls.map(([query]) => query.value)).toEqual([
      'Example Movie 2020',
      'Example Movie',
    ]);
    expect(emptySearch.mock.calls[1]?.[0].fallback).toBe(true);
  });

  it('searches at most two distinct precise titles in parallel', async () => {
    const metadataResolver: MetadataResolver = {
      resolve: vi.fn().mockResolvedValue({
        type: 'movie',
        id: 'tt0000002',
        originalTitle: 'Example Movie',
        czechTitle: 'Ukazkovy Film',
        alternativeTitles: [],
        year: 2020,
      }),
    };
    const search = vi.fn<StreamProvider['search']>().mockResolvedValue([torrentResult('d')]);
    const provider: StreamProvider = {
      name: 'sktorrent',
      capabilities: {
        search: true,
        source: 'torrent',
        requiresAuthentication: true,
        supportsDirectStreaming: false,
        supportsCacheLookup: false,
      },
      search,
    };
    const searchStreams = createSearchStreams({
      metadataResolver,
      providers: [provider],
      configuration: {
        ...configuration,
        providers: { ...configuration.providers, webshare: { enabled: false } },
      },
      caching: false,
    });

    await searchStreams.search(
      { type: 'movie', id: 'tt0000002' },
      { signal: new AbortController().signal, correlationId: 'early-stop-test' },
    );

    expect(search).toHaveBeenCalledTimes(2);
    expect(search.mock.calls.map(([query]) => query.value)).toEqual([
      'Ukazkovy Film 2020',
      'Example Movie 2020',
    ]);
  });

  it('finds anime through a bounded localized and English title pair', async () => {
    const metadataResolver: MetadataResolver = {
      resolve: vi.fn().mockResolvedValue({
        type: 'series',
        id: 'tt13911284',
        originalTitle: '地獄楽',
        englishTitle: "Hell's Paradise",
        czechTitle: 'Pekelný ráj',
        slovakTitle: '地獄楽',
        alternativeTitles: ['Jigokuraku', "Hell's Paradise: Jigokuraku"],
        season: 2,
        episode: 9,
      }),
    };
    const result = animeWebshareResult();
    const search = vi
      .fn<StreamProvider['search']>()
      .mockImplementation((query) =>
        Promise.resolve(query.value === "Hell's Paradise S02E09" ? [result] : []),
      );
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
    const searchStreams = createSearchStreams({
      metadataResolver,
      providers: [provider],
      configuration: {
        ...configuration,
        providers: {
          sktorrent: { enabled: false, playbackMode: 'direct-torrent' },
          webshare: { enabled: true },
        },
      },
      websharePlaybackUrl: () => 'https://addon.example/play/opaque-token',
      caching: false,
      providerExecutionPolicy: false,
    });

    const streams = await searchStreams.search(
      { type: 'series', id: 'tt13911284', season: 2, episode: 9 },
      { signal: new AbortController().signal, correlationId: 'anime-title-selection' },
    );

    expect(search.mock.calls.map(([query]) => query.value)).toEqual([
      'Pekelný ráj S02E09',
      "Hell's Paradise S02E09",
    ]);
    expect(streams).toHaveLength(1);
  });

  it('uses a bounded title-only series fallback after exact and season searches are empty', async () => {
    const metadataResolver: MetadataResolver = {
      resolve: vi.fn().mockResolvedValue({
        type: 'series',
        id: 'tt0475411',
        originalTitle: 'Mafstory',
        alternativeTitles: [],
        season: 1,
        episode: 1,
      }),
    };
    const search = vi.fn<StreamProvider['search']>().mockImplementation((query) =>
      Promise.resolve(
        query.broad === true
          ? [
              {
                ...torrentPackResult('e'),
                title: 'Mafstory - 1. - 11. serie',
                releaseName: 'Mafstory - 1. - 11. serie (2006)(SK)[TvRip]',
                mediaType: 'series' as const,
              },
            ]
          : [],
      ),
    );
    const provider: StreamProvider = {
      name: 'sktorrent',
      capabilities: {
        search: true,
        source: 'torrent',
        requiresAuthentication: true,
        supportsDirectStreaming: false,
        supportsCacheLookup: false,
      },
      search,
    };
    const searchStreams = createSearchStreams({
      metadataResolver,
      providers: [provider],
      configuration: {
        ...configuration,
        providers: {
          ...configuration.providers,
          sktorrent: { enabled: true, playbackMode: 'torbox-only' },
          webshare: { enabled: false },
        },
        filters: {
          ...configuration.filters,
          resolutions: ['1080p'],
          sources: ['web-dl'],
          videoCodecs: ['hevc'],
        },
        torbox: { showUncached: true, precacheCount: 0 },
      },
      cacheEnricher: (results) =>
        Promise.resolve(
          results.map((ranked) => ({
            ...ranked,
            result: { ...ranked.result, cacheStatus: 'uncached' as const },
          })),
        ),
      torboxPlaybackUrl: () => 'https://addon.example/play/opaque-token',
      caching: false,
    });

    const streams = await searchStreams.search(
      { type: 'series', id: 'tt0475411', season: 1, episode: 1 },
      { signal: new AbortController().signal, correlationId: 'series-broad-fallback-test' },
    );

    expect(search.mock.calls.map(([query]) => query.value)).toEqual([
      'Mafstory S01E01',
      'Mafstory S01',
      'Mafstory',
    ]);
    expect(streams).toHaveLength(1);
  });
});

function webshareResult(): FileProviderResult {
  const filename = 'Sintel.2010.1080p.WEB-DL.CZ.HEVC.mkv';
  return {
    provider: 'webshare',
    source: 'file-hosting',
    id: '5m56ZO4cb6',
    fileId: '5m56ZO4cb6',
    title: filename,
    releaseName: filename,
    filename,
    mediaType: 'movie',
    sizeBytes: 2_000_000_000,
    providerUrl: 'https://webshare.cz/#/file/5m56ZO4cb6',
    parsed: parseRelease(filename),
    available: true,
    streamable: true,
  };
}

function animeWebshareResult(): FileProviderResult {
  const filename = 'Hell.s.Paradise.S02E09.1080p.WEB-DL.EN.HEVC.mkv';
  return {
    provider: 'webshare',
    source: 'file-hosting',
    id: 'sanitized-anime-file',
    fileId: 'sanitized-anime-file',
    title: filename,
    releaseName: filename,
    filename,
    mediaType: 'series',
    sizeBytes: 2_000_000_000,
    providerUrl: 'https://webshare.cz/sanitized-anime-file',
    parsed: parseRelease(filename),
    available: true,
    streamable: true,
  };
}

function torrentResult(prefix: string): TorrentProviderResult {
  const filename = `Sintel.2010.1080p.WEB-DL.CZ.HEVC.${prefix}.mkv`;
  const infoHash = prefix.repeat(40);
  return {
    provider: 'sktorrent',
    source: 'torrent',
    id: prefix,
    title: filename,
    releaseName: filename,
    filename,
    mediaType: 'movie',
    year: 2010,
    sizeBytes: 2_000_000_000,
    seeders: 10,
    providerUrl: `https://sktorrent.eu/torrent/details.php?id=${infoHash}`,
    parsed: parseRelease(filename),
    infoHash,
    magnetUri: `magnet:?xt=urn:btih:${infoHash}`,
    cacheStatus: 'unknown',
  };
}

function torrentPackResult(prefix: string): TorrentProviderResult {
  const result = torrentResult(prefix);
  delete result.filename;
  return result;
}

function seriesTorrentResult(episode: number): TorrentProviderResult {
  const episodeText = episode.toString().padStart(2, '0');
  const filename = `Farma.S17E${episodeText}.1080p.WEB-DL.CZ.HEVC.mkv`;
  const prefix = episode.toString(16).slice(-1);
  return {
    ...torrentResult(prefix),
    title: filename,
    releaseName: filename,
    filename,
    mediaType: 'series',
    season: 17,
    episode,
    parsed: parseRelease(filename),
  };
}
