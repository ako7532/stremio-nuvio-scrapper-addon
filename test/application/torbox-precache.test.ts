import { describe, expect, it, vi } from 'vitest';

import {
  createTorboxPrecacheScheduler,
  selectPrecacheCandidates,
} from '../../src/application/torbox-precache.js';
import type {
  PlaybackPrecachePolicy,
  PlaybackReference,
  PrecacheCandidate,
} from '../../src/application/playback-reference-store.js';
import {
  TorboxTransportError,
  type TorboxApiClient,
} from '../../src/providers/torbox/torbox-api-client.js';
import { parseRelease } from '../../src/release/release-parser.js';

const selectedHash = 'a'.repeat(40);
const policy: PlaybackPrecachePolicy = {
  count: 2,
  minimumMatchScore: 70,
  minimumSeeders: 3,
  maximumTorrentSizeBytes: 5_000,
  maximumTotalSizeBytes: 7_000,
  allowedResolutions: ['1080p'],
  preferredAudioLanguages: ['cs'],
  preferredSubtitleLanguages: [],
  preferredLanguagesOnly: true,
};

describe('TorBox precache', () => {
  it('selects only bounded uncached alternatives in their existing ranked order', () => {
    const candidates = [
      candidate('a', 'uncached'),
      candidate('b', 'cached'),
      candidate('c', 'unknown'),
      candidate('d', 'uncached', { matchScore: 60 }),
      candidate('e', 'uncached', { seeders: 2 }),
      candidate('f', 'uncached', { sizeBytes: 6_000 }),
      candidate('1', 'uncached', { releaseName: 'Movie.2020.720p.WEB-DL.CZ.mkv' }),
      candidate('2', 'uncached', { releaseName: 'Movie.2020.1080p.WEB-DL.EN.mkv' }),
      candidate('3', 'uncached', { sizeBytes: 4_000 }),
      candidate('4', 'uncached', { sizeBytes: 4_000 }),
      candidate('3', 'uncached', { sizeBytes: 1_000 }),
      candidate('5', 'uncached', { sizeBytes: 3_000 }),
    ];

    const selected = selectPrecacheCandidates(candidates, policy, new Set([selectedHash]));

    expect(selected.map(({ result }) => result.infoHash)).toEqual(['3'.repeat(40), '5'.repeat(40)]);
  });

  it('deduplicates repeated playback, respects the per-user create budget, and skips account torrents', async () => {
    const createTorrent = vi.fn<TorboxApiClient['createTorrent']>().mockResolvedValue({ id: 1 });
    const scheduler = createTorboxPrecacheScheduler({ maximumCreatesPerWindow: 2 });
    const reference = playbackReference(
      [candidate('b', 'uncached'), candidate('c', 'uncached'), candidate('d', 'uncached')],
      { ...policy, count: 3, preferredLanguagesOnly: false, maximumTotalSizeBytes: 20_000 },
    );
    const request = {
      reference,
      client: client({ createTorrent }),
      accountTorrents: [
        { id: 7, hash: 'b'.repeat(40), name: 'existing', downloadState: 'cached', files: [] },
      ],
    };

    await Promise.all([scheduler.schedule(request), scheduler.schedule(request)]);

    expect(createTorrent).toHaveBeenCalledTimes(2);
    expect(createTorrent.mock.calls.map(([magnet]) => magnet)).toEqual([
      `magnet:?xt=urn:btih:${'c'.repeat(40)}`,
      `magnet:?xt=urn:btih:${'d'.repeat(40)}`,
    ]);
  });

  it('stops on a provider rate limit and honors its backoff for the user', async () => {
    let now = 1_000;
    const createTorrent = vi
      .fn<TorboxApiClient['createTorrent']>()
      .mockRejectedValueOnce(
        new TorboxTransportError('rate-limited', 'limited', { retryAfterMs: 30_000 }),
      )
      .mockResolvedValue({ id: 2 });
    const scheduler = createTorboxPrecacheScheduler({ clock: () => now });
    const first = playbackReference([candidate('b', 'uncached'), candidate('c', 'uncached')], {
      ...policy,
      preferredLanguagesOnly: false,
    });
    const second = playbackReference(
      [candidate('d', 'uncached')],
      {
        ...policy,
        preferredLanguagesOnly: false,
      },
      'reference-second-1234',
    );

    await scheduler.schedule({
      reference: first,
      client: client({ createTorrent }),
      accountTorrents: [],
    });
    await scheduler.schedule({
      reference: second,
      client: client({ createTorrent }),
      accountTorrents: [],
    });
    expect(createTorrent).toHaveBeenCalledOnce();

    now += 30_001;
    const third = playbackReference(
      [candidate('e', 'uncached')],
      {
        ...policy,
        preferredLanguagesOnly: false,
      },
      'reference-third-12345',
    );
    await scheduler.schedule({
      reference: third,
      client: client({ createTorrent }),
      accountTorrents: [],
    });
    expect(createTorrent).toHaveBeenCalledTimes(2);
  });
});

function candidate(
  prefix: string,
  cacheStatus: 'cached' | 'uncached' | 'unknown',
  overrides: {
    matchScore?: number;
    seeders?: number;
    sizeBytes?: number;
    releaseName?: string;
  } = {},
): PrecacheCandidate {
  const infoHash = prefix.repeat(40);
  const releaseName = overrides.releaseName ?? `Movie.2020.1080p.WEB-DL.CZ.${prefix}.mkv`;
  return {
    matchScore: overrides.matchScore ?? 90,
    result: {
      provider: 'sktorrent',
      source: 'torrent',
      id: prefix,
      title: releaseName,
      releaseName,
      filename: releaseName,
      mediaType: 'movie',
      sizeBytes: overrides.sizeBytes ?? 2_000,
      seeders: overrides.seeders ?? 10,
      providerUrl: `https://sktorrent.eu/torrent/details.php?id=${prefix}`,
      parsed: parseRelease(releaseName),
      infoHash,
      magnetUri: `magnet:?xt=urn:btih:${infoHash}`,
      cacheStatus,
    },
  };
}

function playbackReference(
  precacheCandidates: readonly PrecacheCandidate[],
  precachePolicy: PlaybackPrecachePolicy,
  id = 'reference-first-1234',
): PlaybackReference {
  return {
    id,
    configId: 'configuration-1234',
    result: candidate('a', 'cached').result,
    media: { type: 'movie', id: 'tt1234567' },
    precacheCandidates,
    precachePolicy,
    expiresAt: Number.MAX_SAFE_INTEGER,
  };
}

const client = (overrides: Partial<TorboxApiClient>): TorboxApiClient => ({
  validateAuthentication: vi.fn(),
  checkCached: vi.fn(),
  listTorrents: vi.fn(),
  getTorrent: vi.fn(),
  createTorrent: vi.fn(),
  requestDownloadLink: vi.fn(),
  ...overrides,
});
