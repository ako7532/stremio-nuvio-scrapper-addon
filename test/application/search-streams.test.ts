import { describe, expect, it, vi } from 'vitest';

import { createSearchStreams } from '../../src/application/search-streams.js';
import type { UserConfiguration } from '../../src/domain/configuration.js';
import type { FileProviderResult, RankedResult } from '../../src/domain/release.js';
import type { MetadataResolver } from '../../src/metadata/metadata-resolver.js';
import type { StreamProvider } from '../../src/providers/provider.js';
import { parseRelease } from '../../src/release/release-parser.js';

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
    const searchStreams = createSearchStreams({
      metadataResolver,
      providers: [failedProvider, successfulProvider],
      configuration,
      cacheEnricher,
      websharePlaybackUrl: () => 'https://addon.example/play/opaque-token',
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
        name: 'CZ/SK 1080p',
        url: 'https://addon.example/play/opaque-token',
        behaviorHints: { filename: result.filename },
      }),
    ]);
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
