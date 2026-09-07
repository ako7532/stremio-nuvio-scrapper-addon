import { describe, expect, it, vi } from 'vitest';

import { createWebshareProvider } from '../../../src/providers/webshare/webshare-provider.js';
import type { WebshareSource } from '../../../src/providers/webshare/webshare-source.js';

describe('Webshare provider', () => {
  it('returns normalized file results without resolving a temporary playback URL', async () => {
    const resolvePlayback = vi.fn();
    const source: WebshareSource = {
      search: vi.fn().mockResolvedValue([
        {
          id: '5m56ZO4cb6',
          name: 'Sintel.2010.1080p.CZ.AppleTV.mp4',
          type: 'mp4',
          sizeBytes: 2_015_084_270,
          available: true,
          passwordProtected: false,
          removed: false,
          copyrighted: false,
          streamable: true,
          providerUrl: 'https://webshare.cz/#/file/5m56ZO4cb6',
        },
      ]),
      resolvePlayback,
    };
    const provider = createWebshareProvider(source);

    const results = await provider.search(
      { type: 'movie', value: 'Sintel 2010', title: 'Sintel', year: 2010 },
      { signal: new AbortController().signal, correlationId: 'test' },
    );

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      provider: 'webshare',
      source: 'file-hosting',
      id: '5m56ZO4cb6',
      fileId: '5m56ZO4cb6',
      filename: 'Sintel.2010.1080p.CZ.AppleTV.mp4',
      available: true,
      streamable: true,
      parsed: { resolution: '1080p' },
    });
    expect(resolvePlayback).not.toHaveBeenCalled();
  });

  it('does not treat requested series coordinates as provider-confirmed metadata', async () => {
    const source: WebshareSource = {
      search: vi.fn().mockResolvedValue([
        {
          id: '5m56ZO4cb6',
          name: 'Example.Show.S01E02.1080p.mkv',
          type: 'mkv',
          sizeBytes: 1_000,
          available: true,
          passwordProtected: false,
          removed: false,
          copyrighted: false,
          streamable: true,
          providerUrl: 'https://webshare.cz/#/file/5m56ZO4cb6',
        },
      ]),
      resolvePlayback: vi.fn(),
    };
    const provider = createWebshareProvider(source);

    const [result] = await provider.search(
      {
        type: 'series',
        value: 'Example Show S01E01',
        title: 'Example Show',
        season: 1,
        episode: 1,
        seasonPack: false,
      },
      { signal: new AbortController().signal, correlationId: 'test' },
    );

    expect(result).not.toHaveProperty('season');
    expect(result).not.toHaveProperty('episode');
  });

  it('uses one bounded compact query for a trailing year-like title number', async () => {
    const search = vi.fn<WebshareSource['search']>().mockImplementation((value) =>
      Promise.resolve(
        value === 'Runner2049'
          ? [
              {
                id: 'compact-result',
                name: 'Blade-Runner2049(2017).mp4',
                type: 'mp4',
                sizeBytes: 1_000,
                available: true,
                passwordProtected: false,
                removed: false,
                copyrighted: false,
                streamable: true,
                providerUrl: 'https://webshare.cz/sanitized-compact-result',
              },
            ]
          : [],
      ),
    );
    const provider = createWebshareProvider({ search, resolvePlayback: vi.fn() });

    const results = await provider.search(
      {
        type: 'movie',
        value: 'Blade Runner 2049 2017',
        title: 'Blade Runner 2049',
        year: 2017,
      },
      { signal: new AbortController().signal, correlationId: 'compact-title-number' },
    );

    expect(search.mock.calls.map(([value]) => value)).toEqual([
      'Blade Runner 2049 2017',
      'Runner2049',
    ]);
    expect(results).toHaveLength(1);
  });

  it('does not add a compact query for ordinary movies or series', async () => {
    const search = vi.fn<WebshareSource['search']>().mockResolvedValue([]);
    const provider = createWebshareProvider({ search, resolvePlayback: vi.fn() });
    const context = { signal: new AbortController().signal, correlationId: 'ordinary-query' };

    await provider.search(
      { type: 'movie', value: 'Dune 2021', title: 'Dune', year: 2021 },
      context,
    );
    await provider.search(
      {
        type: 'series',
        value: 'Example 1999 S01E01',
        title: 'Example 1999',
        season: 1,
        episode: 1,
        seasonPack: false,
      },
      context,
    );

    expect(search.mock.calls.map(([value]) => value)).toEqual(['Dune 2021', 'Example 1999 S01E01']);
  });
});
