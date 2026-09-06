import { describe, expect, it } from 'vitest';

import {
  buildSktorrentListingUrl,
  normalizeSktorrentDetailUrl,
} from '../../../src/providers/sktorrent/sktorrent-urls.js';

describe('SKTorrent URLs', () => {
  it('builds an encoded listing URL with explicit conservative filters', () => {
    const url = new URL(buildSktorrentListingUrl('  Farma S17E04 & bonus  '));

    expect(url.origin + url.pathname).toBe('https://sktorrent.eu/torrent/torrents_v2.php');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      search: 'Farma S17E04 & bonus',
      category: '0',
      active: '0',
      order: 'data',
      by: 'DESC',
      page: '0',
    });
  });

  it('rejects empty queries and invalid pages', () => {
    expect(() => buildSktorrentListingUrl('  ')).toThrow('search query must not be empty');
    expect(() => buildSktorrentListingUrl('Farma', -1)).toThrow('Invalid SKTorrent listing page');
  });

  it('normalizes only allowlisted detail URLs with an opaque provider ID', () => {
    expect(
      normalizeSktorrentDetailUrl(
        'details.php?name=Sample&id=1111111111111111111111111111111111111111',
      ),
    ).toBe(
      'https://sktorrent.eu/torrent/details.php?name=Sample&id=1111111111111111111111111111111111111111',
    );
    expect(() =>
      normalizeSktorrentDetailUrl(
        'https://example.com/torrent/details.php?id=1111111111111111111111111111111111111111',
      ),
    ).toThrow('Unexpected SKTorrent URL');
    expect(() => normalizeSktorrentDetailUrl('download.php?id=invalid')).toThrow(
      'Unexpected SKTorrent detail URL',
    );
  });
});
