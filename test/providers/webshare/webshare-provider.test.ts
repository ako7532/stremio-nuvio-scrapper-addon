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
});
