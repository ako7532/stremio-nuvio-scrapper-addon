import { readFile } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import { createSktorrentProvider } from '../../../src/providers/sktorrent/sktorrent-provider.js';
import type { SktorrentSource } from '../../../src/providers/sktorrent/sktorrent-source.js';

const providerId = '9ca7792139b16d7f68132ed46ce79f649a72b45b';
const torrentFixture = Buffer.from(
  (
    await readFile(new URL('../../fixtures/sktorrent/sintel.torrent.b64', import.meta.url), 'utf8')
  ).trim(),
  'base64',
);

describe('SKTorrent provider', () => {
  it('returns a normalized torrent only after downloaded metadata verification', async () => {
    const validateAuthentication = vi.fn().mockResolvedValue(undefined);
    const source: SktorrentSource = {
      validateAuthentication,
      search: vi.fn().mockResolvedValue([
        {
          id: providerId,
          title: 'Sintel (2010)(CZ)[2160p][HEVC]',
          category: 'Filmy CZ/SK dabing',
          language: 'cs',
          sizeBytes: 1_000,
          addedDate: '2026-09-06',
          seeders: 5,
          leechers: 0,
          detailUrl: `https://sktorrent.eu/torrent/details.php?id=${providerId}`,
        },
      ]),
      getDetail: vi.fn().mockResolvedValue({
        id: providerId,
        title: 'Sintel (2010)(CZ)[2160p][HEVC]',
        category: 'Filmy CZ/SK dabing',
        language: 'cs',
        sizeBytes: 1_000,
        addedDate: '2026-09-06',
        seeders: 5,
        leechers: 0,
        files: [{ name: 'Sintel.2010.CZ.2160p.HEVC.mkv', sizeBytes: 1_000 }],
        declaredLanguage: 'CZ',
        downloadPath: `download.php?id=${providerId}`,
        providerUrl: `https://sktorrent.eu/torrent/details.php?id=${providerId}`,
      }),
      downloadTorrent: vi.fn().mockResolvedValue(torrentFixture),
    };
    const torrentFileStore = { put: vi.fn(), get: vi.fn(), deleteNamespace: vi.fn() };
    const provider = createSktorrentProvider(source, {
      torrentFiles: { store: torrentFileStore, namespace: 'configuration-a' },
    });

    const results = await provider.search(
      { type: 'movie', value: 'Sintel 2010', title: 'Sintel', year: 2010 },
      { signal: new AbortController().signal, correlationId: 'test' },
    );

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      provider: 'sktorrent',
      source: 'torrent',
      id: providerId,
      infoHash: providerId,
      magnetUri: `magnet:?xt=urn:btih:${providerId}`,
      cacheStatus: 'unknown',
      mediaType: 'movie',
      filename: 'Sintel.2010.CZ.2160p.HEVC.mkv',
    });
    expect(results[0]?.parsed).toMatchObject({ resolution: '2160p', videoCodec: 'hevc' });
    expect(torrentFileStore.put).toHaveBeenCalledWith(
      'configuration-a',
      providerId,
      torrentFixture,
    );
    expect(validateAuthentication).toHaveBeenCalledOnce();
  });

  it('keeps verified results when another listing fails metadata verification', async () => {
    const invalidId = 'a'.repeat(40);
    const listings = [providerId, invalidId].map((id) => ({
      id,
      title: 'Sintel (2010)(CZ)[2160p][HEVC]',
      category: 'Filmy CZ/SK dabing',
      language: 'cs' as const,
      sizeBytes: 1_000,
      addedDate: '2026-09-06',
      seeders: 5,
      leechers: 0,
      detailUrl: `https://sktorrent.eu/torrent/details.php?id=${id}`,
    }));
    const source: SktorrentSource = {
      search: vi.fn().mockResolvedValue(listings),
      getDetail: vi.fn<SktorrentSource['getDetail']>().mockImplementation((listing) =>
        Promise.resolve({
          ...listing,
          files: [{ name: 'Sintel.2010.CZ.2160p.HEVC.mkv', sizeBytes: 1_000 }],
          downloadPath: `download.php?id=${listing.id}`,
          providerUrl: listing.detailUrl,
        }),
      ),
      downloadTorrent: vi.fn().mockResolvedValue(torrentFixture),
    };
    const provider = createSktorrentProvider(source);

    const results = await provider.search(
      { type: 'movie', value: 'Sintel 2010', title: 'Sintel', year: 2010 },
      { signal: new AbortController().signal, correlationId: 'test' },
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe(providerId);
  });

  it('caps detail work before applying its concurrency limit', async () => {
    let active = 0;
    let maximumActive = 0;
    const listings = Array.from({ length: 5 }, (_, index) => ({
      id: String(index).padStart(40, '0'),
      title: `Result ${String(index)}`,
      category: 'Film',
      language: 'unknown' as const,
      sizeBytes: 1,
      addedDate: '2026-09-06',
      seeders: 1,
      leechers: 0,
      detailUrl: `https://sktorrent.eu/torrent/details.php?id=${String(index).padStart(40, '0')}`,
    }));
    const getDetail = vi.fn(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active -= 1;
      throw new Error('stop after measuring concurrency');
    });
    const source: SktorrentSource = {
      search: vi.fn().mockResolvedValue(listings),
      getDetail,
      downloadTorrent: vi.fn(),
    };
    const provider = createSktorrentProvider(source, { maximumDetails: 4, detailConcurrency: 2 });

    await expect(
      provider.search(
        { type: 'movie', value: 'Result', title: 'Result' },
        { signal: new AbortController().signal, correlationId: 'test' },
      ),
    ).rejects.toThrow('stop after measuring concurrency');
    expect(getDetail).toHaveBeenCalledTimes(4);
    expect(maximumActive).toBe(2);
  });

  it('spreads bounded detail work across listed resolutions', async () => {
    const listings = ['2160p-a', '2160p-b', '2160p-c', '1080p-a', '720p-a', 'unknown-a'].map(
      (title, index) => ({
        id: String(index).padStart(40, '0'),
        title,
        category: 'Film',
        language: 'unknown' as const,
        sizeBytes: 1,
        addedDate: '2026-09-06',
        seeders: 1,
        leechers: 0,
        detailUrl: `https://sktorrent.eu/torrent/details.php?id=${String(index).padStart(40, '0')}`,
      }),
    );
    const getDetail = vi
      .fn<SktorrentSource['getDetail']>()
      .mockRejectedValue(new Error('stop after selection'));
    const source: SktorrentSource = {
      search: vi.fn().mockResolvedValue(listings),
      getDetail,
      downloadTorrent: vi.fn(),
    };
    const provider = createSktorrentProvider(source, { maximumDetails: 4, detailConcurrency: 1 });

    await expect(
      provider.search(
        { type: 'movie', value: 'Result', title: 'Result' },
        { signal: new AbortController().signal, correlationId: 'test' },
      ),
    ).rejects.toThrow('stop after selection');
    expect(getDetail.mock.calls.map(([listing]) => listing.title)).toEqual([
      '2160p-a',
      '1080p-a',
      '720p-a',
      'unknown-a',
    ]);
  });

  it('narrows broad series results to listings that cover the requested season', async () => {
    const listings = ['Mafstory - 1. - 11. serie', 'Mafstory 7. serie'].map((title, index) => ({
      id: String(index).padStart(40, '0'),
      title,
      category: 'Serial',
      language: 'sk' as const,
      sizeBytes: 1,
      addedDate: '2026-09-06',
      seeders: 1,
      leechers: 0,
      detailUrl: `https://sktorrent.eu/torrent/details.php?id=${String(index).padStart(40, '0')}`,
    }));
    const getDetail = vi
      .fn<SktorrentSource['getDetail']>()
      .mockRejectedValue(new Error('stop after selection'));
    const provider = createSktorrentProvider(
      {
        search: vi.fn().mockResolvedValue(listings),
        getDetail,
        downloadTorrent: vi.fn(),
      },
      { detailConcurrency: 1 },
    );

    await expect(
      provider.search(
        {
          type: 'series',
          value: 'Mafstory',
          title: 'Mafstory',
          season: 1,
          seasonPack: true,
          fallback: true,
          broad: true,
        },
        { signal: new AbortController().signal, correlationId: 'test' },
      ),
    ).rejects.toThrow('stop after selection');
    expect(getDetail).toHaveBeenCalledOnce();
    expect(getDetail.mock.calls[0]?.[0].title).toBe('Mafstory - 1. - 11. serie');
  });
});
