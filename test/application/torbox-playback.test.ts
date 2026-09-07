import { describe, expect, it, vi } from 'vitest';

import {
  createTorboxPlaybackResolver,
  createTorboxPlaybackUrlFactory,
  PlaybackResolveError,
  selectVideoFile,
} from '../../src/application/torbox-playback.js';
import { createPlaybackReferenceStore } from '../../src/application/playback-reference-store.js';
import type { TorrentFileStore } from '../../src/application/torrent-file-store.js';
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
  it('uses a distinct download route for an uncached result', () => {
    const references = createPlaybackReferenceStore({ createId: () => 'result-reference-1234' });
    const playbackUrl = createTorboxPlaybackUrlFactory({
      baseUrl: 'https://addon.example/',
      configId,
      references,
    });

    const url = playbackUrl(
      { ...result, cacheStatus: 'uncached' },
      { type: 'series', id: 'tt1234567', season: 1, episode: 2 },
      [],
      configuration,
    );

    expect(new URL(url).pathname).toMatch(/^\/download\//u);
  });

  it('selects the requested episode from a season pack', () => {
    expect(
      selectVideoFile(torrent, { type: 'series', id: 'tt1234567', season: 1, episode: 2 }),
    ).toEqual(torrent.files[1]);
  });

  it('creates a selected torrent once and returns pending across concurrent playback requests', async () => {
    const listTorrents = vi.fn<TorboxApiClient['listTorrents']>().mockResolvedValue([]);
    const createTorrent = vi
      .fn<TorboxApiClient['createTorrent']>()
      .mockResolvedValue({ id: 42, hash });
    const requestDownloadLink = vi
      .fn<TorboxApiClient['requestDownloadLink']>()
      .mockResolvedValue('https://cdn.torbox.app/fixture-video');
    const api = client({ listTorrents, createTorrent, requestDownloadLink });
    const setup = playbackSetup(api);

    const [first, second] = await Promise.all([
      setup.resolver.resolve(setup.token),
      setup.resolver.resolve(setup.token),
    ]);

    expect(first).toEqual({
      url: 'https://addon.example/status/torbox-downloading.mp4',
      filename: 'torbox-downloading.mp4',
      pending: true,
    });
    expect(second).toEqual(first);
    expect(createTorrent).toHaveBeenCalledOnce();
    expect(requestDownloadLink).not.toHaveBeenCalled();
  });

  it('checks TorBox only after playback and does not add a disabled uncached torrent', async () => {
    const checkCached = vi
      .fn<TorboxApiClient['checkCached']>()
      .mockResolvedValue([{ hash, status: 'uncached' }]);
    const createTorrent = vi.fn<TorboxApiClient['createTorrent']>();
    const setup = playbackSetup(
      client({
        checkCached,
        listTorrents: vi.fn().mockResolvedValue([]),
        createTorrent,
      }),
    );

    await setup.resolver.inspect(setup.token);
    expect(checkCached).not.toHaveBeenCalled();
    await expect(setup.resolver.resolve(setup.token)).rejects.toMatchObject({
      kind: 'torrent-unavailable',
    });
    expect(checkCached).toHaveBeenCalledWith([hash], undefined);
    expect(createTorrent).not.toHaveBeenCalled();
  });

  it('adds an uncached torrent only after playback when the option is enabled', async () => {
    const checkCached = vi.fn<TorboxApiClient['checkCached']>();
    const createTorrent = vi
      .fn<TorboxApiClient['createTorrent']>()
      .mockResolvedValue({ id: 42, hash });
    const setup = playbackSetup(
      client({
        checkCached,
        listTorrents: vi.fn().mockResolvedValue([]),
        createTorrent,
      }),
      undefined,
      undefined,
      { ...configuration, torbox: { showUncached: true, precacheCount: 0 } },
    );

    expect(createTorrent).not.toHaveBeenCalled();
    await expect(setup.resolver.resolve(setup.token)).resolves.toMatchObject({ pending: true });
    expect(checkCached).not.toHaveBeenCalled();
    expect(createTorrent).toHaveBeenCalledOnce();
  });

  it('uploads verified torrent metadata when it is available for the configuration', async () => {
    const createTorrent = vi.fn<TorboxApiClient['createTorrent']>();
    const createTorrentFile = vi
      .fn<NonNullable<TorboxApiClient['createTorrentFile']>>()
      .mockResolvedValue({ id: 42, hash });
    const getTorrentFile = vi.fn().mockReturnValue(Uint8Array.from([100, 101]));
    const torrentFiles: TorrentFileStore = {
      put: vi.fn(),
      get: getTorrentFile,
      deleteNamespace: vi.fn(),
    };
    const setup = playbackSetup(
      client({
        listTorrents: vi.fn().mockResolvedValue([]),
        createTorrent,
        createTorrentFile,
      }),
      undefined,
      torrentFiles,
    );

    await expect(setup.resolver.resolve(setup.token)).resolves.toMatchObject({ pending: true });
    expect(createTorrentFile).toHaveBeenCalledOnce();
    expect(createTorrent).not.toHaveBeenCalled();
    expect(getTorrentFile).toHaveBeenCalledWith(configId, hash);
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

  it('shows a local status video while an uncached torrent downloads and retries fresh state', async () => {
    const downloading: TorboxTorrent = {
      ...torrent,
      downloadState: 'downloading',
      downloadFinished: false,
      downloadPresent: false,
    };
    const ready: TorboxTorrent = {
      ...torrent,
      downloadState: 'completed',
      downloadFinished: true,
      downloadPresent: true,
    };
    const listTorrents = vi
      .fn<TorboxApiClient['listTorrents']>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([downloading]);
    const createTorrent = vi
      .fn<TorboxApiClient['createTorrent']>()
      .mockResolvedValue({ id: 42, hash });
    const getTorrent = vi.fn<TorboxApiClient['getTorrent']>().mockResolvedValueOnce(ready);
    const requestDownloadLink = vi
      .fn<TorboxApiClient['requestDownloadLink']>()
      .mockResolvedValue('https://cdn.torbox.app/fixture-video');
    const setup = playbackSetup(
      client({ listTorrents, createTorrent, getTorrent, requestDownloadLink }),
    );

    await expect(setup.resolver.resolve(setup.token)).resolves.toEqual({
      url: 'https://addon.example/status/torbox-downloading.mp4',
      filename: 'torbox-downloading.mp4',
      pending: true,
    });
    await expect(setup.resolver.resolve(setup.token)).resolves.toMatchObject({
      url: 'https://cdn.torbox.app/fixture-video',
    });
    expect(createTorrent).toHaveBeenCalledOnce();
    expect(requestDownloadLink).toHaveBeenCalledOnce();
  });

  it('accepts the current TorBox CDN host', async () => {
    const api = client({
      listTorrents: vi.fn().mockResolvedValue([torrent]),
      requestDownloadLink: vi
        .fn()
        .mockResolvedValue('https://store-040.wnam.tb-cdn.io/fixture-video'),
    });
    const setup = playbackSetup(api);

    await expect(setup.resolver.resolve(setup.token)).resolves.toMatchObject({
      url: 'https://store-040.wnam.tb-cdn.io/fixture-video',
    });
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
  torrentFiles?: TorrentFileStore,
  playbackConfiguration: UserConfiguration = configuration,
) => {
  const tokens = createPlayTokenService({ secret: 'fixture-secret-with-at-least-32-bytes' });
  const references = createPlaybackReferenceStore({ createId: () => 'result-reference-1234' });
  const playbackUrl = createTorboxPlaybackUrlFactory({
    baseUrl: 'https://addon.example/',
    configId,
    references,
  });
  const url = playbackUrl(
    result,
    { type: 'series', id: 'tt1234567', season: 1, episode: 2 },
    [],
    playbackConfiguration,
  );
  const parsedUrl = new URL(url);
  expect(parsedUrl.pathname.split('/').at(-1)).toBe('video.mp4');
  const token = parsedUrl.pathname.split('/').at(-2) ?? '';
  expect(token).toMatch(/^[A-Za-z\d_-]{16,32}$/u);
  const resolver = createTorboxPlaybackResolver({
    tokens,
    references,
    credentials: {
      get: vi.fn().mockResolvedValue({ configId, apiKey: 'server-held-fixture-key' }),
    },
    createClient: () => api,
    pendingPlaybackUrl: 'https://addon.example/status/torbox-downloading.mp4',
    ...(precache === undefined ? {} : { precache }),
    ...(torrentFiles === undefined ? {} : { torrentFiles }),
  });
  return { token, resolver };
};

const client = (overrides: Partial<TorboxApiClient>): TorboxApiClient => ({
  validateAuthentication: vi.fn(),
  checkCached: vi.fn().mockResolvedValue([{ hash, status: 'cached' }]),
  listTorrents: vi.fn(),
  getTorrent: vi.fn(),
  createTorrent: vi.fn(),
  requestDownloadLink: vi.fn(),
  ...overrides,
});
