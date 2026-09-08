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
        name: '🇸🇰 SKTorrent • 1080p',
        title:
          'Movie.1080p.WEB-DL.SK.HEVC.EAC3.5.1.mkv\n🎧 🇸🇰 SK • 🎞️ 1080p • 📺 WEB-DL • 🎥 HEVC\n💾 2.0 GB • 🔊 EAC3 5.1 • 🌱 34\n🧲 Direct P2P',
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
        type: 'movie',
        url: 'https://addon.example/play/opaque-token',
        behaviorHints: {
          filename: result.filename,
          notWebReady: true,
          videoSize: result.sizeBytes,
        },
      }),
    ]);
    expect(streams[0]).not.toHaveProperty('infoHash');
  });

  it('keeps Indexers TorBox-only even when SKTorrent direct playback is enabled', () => {
    const indexerResult: TorrentProviderResult = {
      ...result,
      provider: 'indexers',
      id: 'indexer-result',
      providerUrl: 'https://indexer-backend.example/release',
    };
    const streams = formatStreams(
      [{ ...ranked, result: indexerResult }],
      configuration('direct-torrent'),
      undefined,
      () => 'https://addon.example/play/opaque-token',
      { type: 'movie', id: 'tt0807840' },
    );

    expect(streams).toEqual([
      expect.objectContaining({
        name: '🧲 Indexers • 1080p',
        type: 'movie',
        url: 'https://addon.example/play/opaque-token',
      }),
    ]);
    expect(streams[0]).not.toHaveProperty('infoHash');
  });

  it('clearly marks an uncached TorBox stream as requiring a first download attempt', () => {
    const streams = formatStreams(
      [{ ...ranked, result: { ...result, cacheStatus: 'uncached' } }],
      configuration('torbox-only'),
      undefined,
      () => 'https://addon.example/play/opaque-token',
      { type: 'movie', id: 'tt0807840' },
    );

    expect(streams[0]?.title).toContain('⬇️ TorBox • UNCACHED • download starts after click');
  });

  it('uses language flags and honestly marks deferred TorBox cache status', () => {
    const indexerResult: TorrentProviderResult = {
      ...result,
      provider: 'indexers',
      id: 'indexer-unknown-cache',
      cacheStatus: 'unknown',
      parsed: parseRelease('Movie.2160p.WEB-DL.EN.HEVC.CZ.SUBS.mkv'),
    };
    const streams = formatStreams(
      [{ ...ranked, result: indexerResult }],
      configuration('direct-torrent'),
      undefined,
      () => 'https://addon.example/play/opaque-token',
      { type: 'movie', id: 'tt0807840' },
    );

    expect(streams[0]).toEqual(
      expect.objectContaining({
        name: '🧲 Indexers • 4K',
        title: expect.stringContaining('🎧 🇬🇧 EN') as unknown,
      }),
    );
    expect(streams[0]?.title).toContain('💬 🇨🇿 CZ subtitles');
    expect(streams[0]?.title).toContain('❔ TorBox cache • checked after click');
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
