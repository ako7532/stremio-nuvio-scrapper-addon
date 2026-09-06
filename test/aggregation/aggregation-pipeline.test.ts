import { describe, expect, it } from 'vitest';

import { deduplicateResults } from '../../src/aggregation/result-deduplicator.js';
import { filterResults } from '../../src/aggregation/result-filters.js';
import { limitResults, maximumTotalResults } from '../../src/aggregation/result-limits.js';
import { rankResults } from '../../src/aggregation/result-ranking.js';
import type { UserConfiguration } from '../../src/domain/configuration.js';
import type {
  FileProviderResult,
  RankedResult,
  TorrentProviderResult,
} from '../../src/domain/release.js';
import { parseRelease } from '../../src/release/release-parser.js';

const configuration: UserConfiguration = {
  providers: {
    sktorrent: { enabled: true, playbackMode: 'direct-torrent' },
    webshare: { enabled: true },
  },
  filters: {
    resolutions: ['2160p', '1080p', '720p', 'unknown'],
    sources: ['web-dl', 'bluray', 'unknown'],
    videoCodecs: ['hevc', 'avc', 'unknown'],
    dynamicRanges: ['hdr10', 'sdr', 'unknown'],
    minimumSeeders: 0,
    includeTerms: [],
    excludeTerms: [],
  },
  languages: {
    mode: 'fallback',
    audio: { preferred: ['sk', 'cs'], allowed: ['en'], excluded: [] },
    subtitles: { preferred: ['sk', 'cs'], allowed: ['en'], excluded: [] },
  },
  ranking: ['language', 'resolution', 'seeders'],
  limits: { total: 10, perResolution: {} },
  torbox: { showUncached: false, precacheCount: 0 },
  display: { mode: 'compact' },
};

describe('aggregation pipeline stages', () => {
  it('deduplicates only within provider identity and keeps the strongest match', () => {
    const first = ranked(torrent('A'.repeat(40), 'Movie.1080p.mkv'), 70);
    const stronger = ranked(torrent('a'.repeat(40), 'Movie.1080p.REPACK.mkv'), 90);
    const webshare = ranked(file('A'.repeat(40), 'Movie.1080p.mkv'), 80);

    const results = deduplicateResults([first, stronger, webshare]);

    expect(results).toHaveLength(2);
    expect(results[0]?.matchScore).toBe(90);
    expect(results[1]?.result.provider).toBe('webshare');
  });

  it('applies availability, technical, term, seeder, and language filters', () => {
    const accepted = ranked(torrent('a'.repeat(40), 'Movie.1080p.WEB-DL.SK.HEVC.mkv', 5), 90);
    const excludedTerm = ranked(torrent('b'.repeat(40), 'Movie.1080p.WEB-DL.CAM.mkv', 5), 90);
    const unavailable = ranked(
      { ...file('file-id', 'Movie.1080p.WEB-DL.SK.mkv'), streamable: false },
      90,
    );
    const tooSmall = ranked(
      { ...file('small-file', 'Movie.1080p.WEB-DL.SK.HEVC.mkv'), sizeBytes: 100 },
      90,
    );
    const strictConfiguration: UserConfiguration = {
      ...configuration,
      filters: {
        ...configuration.filters,
        minimumSizeBytes: 1_000,
        minimumSeeders: 2,
        includeTerms: ['Movie'],
        excludeTerms: ['', 'CAM'],
      },
      languages: {
        ...configuration.languages,
        mode: 'strict',
        subtitles: { preferred: [], allowed: [], excluded: [] },
      },
    };

    expect(
      filterResults([accepted, excludedTerm, unavailable, tooSmall], strictConfiguration),
    ).toEqual([accepted]);
  });

  it('does not apply torrent health requirements to file-hosting results', () => {
    const webshare = ranked(file('file-id', 'Movie.1080p.WEB-DL.SK.HEVC.mkv'), 90);
    const strictSeeders: UserConfiguration = {
      ...configuration,
      filters: { ...configuration.filters, minimumSeeders: 50 },
    };

    expect(filterResults([webshare], strictSeeders)).toEqual([webshare]);
  });

  it('ranks lexicographically, uses stable tie-breakers, then applies per-resolution before total limits', () => {
    const lowLanguage4k = ranked(torrent('c'.repeat(40), 'Movie.2160p.WEB-DL.EN.HEVC.mkv', 20), 90);
    const preferred1080p = ranked(torrent('b'.repeat(40), 'Movie.1080p.WEB-DL.SK.HEVC.mkv', 2), 90);
    const preferred1080pMoreSeeders = ranked(
      torrent('a'.repeat(40), 'Movie.1080p.WEB-DL.SK.HEVC.mkv', 10),
      90,
    );
    const rankedResults = rankResults(
      [lowLanguage4k, preferred1080p, preferred1080pMoreSeeders],
      configuration,
    );

    expect(rankedResults.map(({ result }) => result.id)).toEqual([
      'a'.repeat(40),
      'b'.repeat(40),
      'c'.repeat(40),
    ]);
    expect(
      limitResults(rankedResults, { total: 2, perResolution: { '1080p': 1 } }).map(
        ({ result }) => result.id,
      ),
    ).toEqual(['a'.repeat(40), 'c'.repeat(40)]);
  });

  it('enforces the server result cap and rejects invalid limits', () => {
    const candidate = ranked(torrent('a'.repeat(40), 'Movie.1080p.mkv'), 90);

    expect(
      limitResults(
        Array.from({ length: maximumTotalResults + 1 }, () => candidate),
        {
          total: maximumTotalResults + 1,
          perResolution: {},
        },
      ),
    ).toHaveLength(maximumTotalResults);
    expect(() => limitResults([candidate], { total: -1, perResolution: {} })).toThrow(RangeError);
  });
});

function ranked(
  result: TorrentProviderResult | FileProviderResult,
  matchScore: number,
): RankedResult {
  return { result, matchScore, rankValues: {} };
}

function torrent(infoHash: string, filename: string, seeders = 1): TorrentProviderResult {
  return {
    provider: 'sktorrent',
    source: 'torrent',
    id: infoHash,
    title: filename,
    releaseName: filename,
    mediaType: 'movie',
    filename,
    sizeBytes: 2_000,
    seeders,
    providerUrl: `https://sktorrent.eu/torrent/details.php?id=${infoHash}`,
    parsed: parseRelease(filename),
    infoHash,
    cacheStatus: 'unknown',
  };
}

function file(fileId: string, filename: string): FileProviderResult {
  return {
    provider: 'webshare',
    source: 'file-hosting',
    id: fileId,
    fileId,
    title: filename,
    releaseName: filename,
    mediaType: 'movie',
    filename,
    providerUrl: `https://webshare.cz/#/file/${fileId}`,
    parsed: parseRelease(filename),
    available: true,
    streamable: true,
  };
}
