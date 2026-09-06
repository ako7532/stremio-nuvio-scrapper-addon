import { describe, expect, it, vi } from 'vitest';

import { createCachedSktorrentSource } from '../../../src/providers/sktorrent/sktorrent-cache.js';
import type { SktorrentSource } from '../../../src/providers/sktorrent/sktorrent-source.js';

describe('SKTorrent detail cache', () => {
  it('caches successful details without changing the source contract', async () => {
    const getDetail = vi.fn<SktorrentSource['getDetail']>().mockResolvedValue({
      id: 'a'.repeat(40),
      title: 'Fixture',
      category: 'Film',
      language: 'unknown',
      sizeBytes: 1,
      addedDate: '2026-09-06',
      seeders: 1,
      leechers: 0,
      files: [{ name: 'fixture.mkv', sizeBytes: 1 }],
      downloadPath: `/torrent/download.php?id=${'a'.repeat(40)}`,
      providerUrl: `https://sktorrent.eu/torrent/details.php?id=${'a'.repeat(40)}`,
    });
    const source: SktorrentSource = {
      search: vi.fn(),
      getDetail,
      downloadTorrent: vi.fn(),
    };
    const cached = createCachedSktorrentSource(source);
    const listing = {
      id: 'a'.repeat(40),
      title: 'Fixture',
      category: 'Film',
      language: 'unknown' as const,
      sizeBytes: 1,
      addedDate: '2026-09-06',
      seeders: 1,
      leechers: 0,
      detailUrl: `https://sktorrent.eu/torrent/details.php?id=${'a'.repeat(40)}`,
    };

    const first = await cached.getDetail(listing);
    const second = await cached.getDetail(listing);

    expect(getDetail).toHaveBeenCalledOnce();
    expect(first).not.toBe(second);
    expect(first.files).not.toBe(second.files);
    expect(second.files[0]?.name).toBe('fixture.mkv');
  });
});
