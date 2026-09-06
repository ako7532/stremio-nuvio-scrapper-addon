import { describe, expect, it } from 'vitest';

import type { UserConfiguration } from '../../src/domain/configuration.js';
import type { RankedResult, TorrentProviderResult } from '../../src/domain/release.js';
import { formatStreams } from '../../src/http/stream-formatter.js';
import { parseRelease } from '../../src/release/release-parser.js';

const result: TorrentProviderResult = {
  provider: 'sktorrent',
  source: 'torrent',
  id: 'a'.repeat(40),
  title: 'Movie.1080p.WEB-DL.SK.HEVC.EAC3.5.1.mkv',
  releaseName: 'Movie.1080p.WEB-DL.SK.HEVC.EAC3.5.1.mkv',
  filename: 'Movie.1080p.WEB-DL.SK.HEVC.EAC3.5.1.mkv',
  mediaType: 'movie',
  sizeBytes: 2_147_483_648,
  seeders: 34,
  providerUrl: 'https://sktorrent.eu/torrent/details.php?id=test',
  parsed: parseRelease('Movie.1080p.WEB-DL.SK.HEVC.EAC3.5.1.mkv'),
  infoHash: 'a'.repeat(40),
  cacheStatus: 'cached',
};
const ranked: RankedResult = { result, matchScore: 90, rankValues: {} };

describe('Stremio stream formatter', () => {
  it('formats a detailed direct torrent result without a playback-side effect', () => {
    const streams = formatStreams([ranked], configuration('direct-torrent'));

    expect(streams).toEqual([
      {
        name: 'CZ/SK 1080p',
        title: 'SK 1080p WEB-DL HEVC\n2.0 GB • EAC3 • SKTorrent • S:34 • cached',
        infoHash: 'a'.repeat(40),
        behaviorHints: { filename: result.filename },
      },
    ]);
  });

  it('does not expose a raw torrent when TorBox-only playback is selected', () => {
    expect(formatStreams([ranked], configuration('torbox-only'))).toEqual([]);
  });

  it('formats a TorBox-only result with an addon-owned URL and no raw info hash', () => {
    const streams = formatStreams(
      [ranked],
      configuration('torbox-only'),
      undefined,
      () => 'https://addon.example/play/opaque-token',
      { type: 'movie', id: 'tt0807840' },
    );

    expect(streams).toEqual([
      expect.objectContaining({
        url: 'https://addon.example/play/opaque-token',
        behaviorHints: { filename: result.filename },
      }),
    ]);
    expect(streams[0]).not.toHaveProperty('infoHash');
  });

  it('does not expose an unresolved multi-file series torrent', () => {
    const seriesTorrent: TorrentProviderResult = { ...result, mediaType: 'series' };
    delete seriesTorrent.filename;
    const seriesResult: RankedResult = {
      ...ranked,
      result: seriesTorrent,
    };

    expect(formatStreams([seriesResult], configuration('direct-torrent'))).toEqual([]);
  });
});

function configuration(playbackMode: 'direct-torrent' | 'torbox-only'): UserConfiguration {
  return {
    providers: { sktorrent: { enabled: true, playbackMode }, webshare: { enabled: true } },
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
      audio: { preferred: ['sk'], allowed: [], excluded: [] },
      subtitles: { preferred: [], allowed: [], excluded: [] },
    },
    ranking: ['resolution'],
    limits: { total: 10, perResolution: {} },
    torbox: { showUncached: false, precacheCount: 0 },
    display: { mode: 'detailed' },
  };
}
