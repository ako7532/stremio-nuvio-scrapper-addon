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
    const source: SktorrentSource = {
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
    const provider = createSktorrentProvider(source);

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
    expect(getDetail).toHaveBeenCalledTimes(2);
    expect(maximumActive).toBe(2);
  });
});
