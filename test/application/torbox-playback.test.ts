import { describe, expect, it, vi } from 'vitest';

import {
  createTorboxPlaybackResolver,
  createTorboxPlaybackUrlFactory,
  PlaybackResolveError,
  selectVideoFile,
} from '../../src/application/torbox-playback.js';
import { createPlaybackReferenceStore } from '../../src/application/playback-reference-store.js';
import type { UserConfiguration } from '../../src/domain/configuration.js';
import type { TorrentProviderResult } from '../../src/domain/release.js';
import type { TorboxApiClient } from '../../src/providers/torbox/torbox-api-client.js';
import type { TorboxTorrent } from '../../src/providers/torbox/torbox-types.js';
import { createPlayTokenService } from '../../src/security/play-token.js';

const hash = 'a'.repeat(40);
const configId = 'config-reference-1234';
const configuration: UserConfiguration = {
  providers: {
    sktorrent: { enabled: true, playbackMode: 'torbox-only' },
    webshare: { enabled: false },
  },
  filters: {
    resolutions: ['1080p'],
    sources: ['web-dl'],
    videoCodecs: ['unknown'],
    dynamicRanges: ['unknown'],
    minimumSeeders: 0,
    includeTerms: [],
    excludeTerms: [],
  },
  languages: {
    mode: 'fallback',
    audio: { preferred: ['cs'], allowed: [], excluded: [] },
    subtitles: { preferred: ['cs'], allowed: [], excluded: [] },
  },
  ranking: ['cached'],
  limits: { total: 5, perResolution: {} },
  torbox: { showUncached: false, precacheCount: 0 },
  display: { mode: 'compact' },
};
const result: TorrentProviderResult = {
  provider: 'sktorrent',
  source: 'torrent',
  id: 'provider-result',
  title: 'Fixture Show S01',
  releaseName: 'Fixture.Show.S01.1080p.mkv',
  mediaType: 'series',
  providerUrl: 'https://sktorrent.eu/torrent/details.php?id=fixture',
  infoHash: hash,
  magnetUri: `magnet:?xt=urn:btih:${hash}`,
  cacheStatus: 'cached',
};
const torrent: TorboxTorrent = {
  id: 42,
  hash,
  name: 'Fixture Show S01',
  downloadState: 'cached',
  files: [
    { id: 0, name: 'Fixture.Show.S01E01.mkv', sizeBytes: 1000 },
    { id: 1, name: 'Fixture.Show.S01E02.mkv', sizeBytes: 2000 },
    { id: 2, name: 'Fixture.Show.S01E02.sample.mkv', sizeBytes: 100 },
  ],
};

describe('TorBox playback', () => {
  it('selects the requested episode from a season pack', () => {
    expect(
      selectVideoFile(torrent, { type: 'series', id: 'tt1234567', season: 1, episode: 2 }),
    ).toEqual(torrent.files[1]);
  });

  it('creates and resolves a selected torrent once across concurrent playback requests', async () => {
    const listTorrents = vi.fn<TorboxApiClient['listTorrents']>().mockResolvedValue([]);
    const createTorrent = vi
      .fn<TorboxApiClient['createTorrent']>()
      .mockResolvedValue({ id: 42, hash });
    const getTorrent = vi.fn<TorboxApiClient['getTorrent']>().mockResolvedValue(torrent);
    const requestDownloadLink = vi
      .fn<TorboxApiClient['requestDownloadLink']>()
      .mockResolvedValue('https://cdn.torbox.app/fixture-video');
    const api = client({ listTorrents, createTorrent, getTorrent, requestDownloadLink });
    const setup = playbackSetup(api);

    const [first, second] = await Promise.all([
      setup.resolver.resolve(setup.token),
      setup.resolver.resolve(setup.token),
    ]);

    expect(first).toEqual({
      url: 'https://cdn.torbox.app/fixture-video',
      filename: 'Fixture.Show.S01E02.mkv',
    });
    expect(second).toEqual(first);
    expect(createTorrent).toHaveBeenCalledOnce();
    expect(requestDownloadLink).toHaveBeenCalledOnce();
    expect(requestDownloadLink).toHaveBeenCalledWith(42, 1, undefined);
  });

  it('reuses an existing account torrent without adding it again', async () => {
    const createTorrent = vi.fn<TorboxApiClient['createTorrent']>();
    const api = client({
      listTorrents: vi.fn().mockResolvedValue([torrent]),
      createTorrent,
      requestDownloadLink: vi.fn().mockResolvedValue('https://cdn.torbox.app/fixture-video'),
    });
    const setup = playbackSetup(api);

    await expect(setup.resolver.resolve(setup.token)).resolves.toMatchObject({
      filename: 'Fixture.Show.S01E02.mkv',
    });
    expect(createTorrent).not.toHaveBeenCalled();
  });

  it('rejects provider links outside the allowlist', async () => {
    const api = client({
      listTorrents: vi.fn().mockResolvedValue([torrent]),
      requestDownloadLink: vi.fn().mockResolvedValue('https://127.0.0.1/private'),
    });
    const setup = playbackSetup(api);

    await expect(setup.resolver.resolve(setup.token)).rejects.toEqual(
      expect.objectContaining<Partial<PlaybackResolveError>>({ kind: 'invalid-provider-url' }),
    );
  });

  it('starts precache once after selected playback resolves without waiting for it', async () => {
    const events: string[] = [];
    const neverFinishes = new Promise<void>(() => undefined);
    const schedule = vi.fn(() => {
      events.push('precache');
      return neverFinishes;
    });
    const api = client({
      listTorrents: vi.fn().mockResolvedValue([torrent]),
      requestDownloadLink: vi.fn().mockImplementation(() => {
        events.push('playback');
        return Promise.resolve('https://cdn.torbox.app/fixture-video');
      }),
    });
    const setup = playbackSetup(api, { schedule });

    const first = await setup.resolver.resolve(setup.token);
    const second = await setup.resolver.resolve(setup.token);

    expect(first.url).toBe('https://cdn.torbox.app/fixture-video');
    expect(second).toEqual(first);
    expect(events).toEqual(['playback', 'precache']);
    expect(schedule).toHaveBeenCalledOnce();
  });

  it('keeps selected playback successful when precache fails', async () => {
    const api = client({
      listTorrents: vi.fn().mockResolvedValue([torrent]),
      requestDownloadLink: vi.fn().mockResolvedValue('https://cdn.torbox.app/fixture-video'),
    });
    const asynchronousFailure = playbackSetup(api, {
      schedule: vi.fn().mockRejectedValue(new Error('precache unavailable')),
    });
    const synchronousFailure = playbackSetup(api, {
      schedule: vi.fn().mockImplementation(() => {
        throw new Error('precache unavailable');
      }),
    });

    await expect(
      asynchronousFailure.resolver.resolve(asynchronousFailure.token),
    ).resolves.toMatchObject({ url: 'https://cdn.torbox.app/fixture-video' });
    await expect(
      synchronousFailure.resolver.resolve(synchronousFailure.token),
    ).resolves.toMatchObject({ url: 'https://cdn.torbox.app/fixture-video' });
  });
});

const playbackSetup = (
  api: TorboxApiClient,
  precache?: Parameters<typeof createTorboxPlaybackResolver>[0]['precache'],
) => {
  const tokens = createPlayTokenService({ secret: 'fixture-secret-with-at-least-32-bytes' });
  const references = createPlaybackReferenceStore({ createId: () => 'result-reference-1234' });
  const playbackUrl = createTorboxPlaybackUrlFactory({
    baseUrl: 'https://addon.example/',
    configId,
    tokens,
    references,
  });
  const url = playbackUrl(
    result,
    { type: 'series', id: 'tt1234567', season: 1, episode: 2 },
    [],
    configuration,
  );
  const token = new URL(url).pathname.split('/').at(-1) ?? '';
  const resolver = createTorboxPlaybackResolver({
    tokens,
    references,
    credentials: {
      get: vi.fn().mockResolvedValue({ configId, apiKey: 'server-held-fixture-key' }),
    },
    createClient: () => api,
    ...(precache === undefined ? {} : { precache }),
  });
  return { token, resolver };
};

const client = (overrides: Partial<TorboxApiClient>): TorboxApiClient => ({
  validateAuthentication: vi.fn(),
  checkCached: vi.fn(),
  listTorrents: vi.fn(),
  getTorrent: vi.fn(),
  createTorrent: vi.fn(),
  requestDownloadLink: vi.fn(),
  ...overrides,
});
