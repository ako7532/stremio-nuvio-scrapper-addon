import { readFile } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import { createTmdbClient, type TmdbClient } from '../../src/metadata/tmdb-client.js';
import { createTmdbMetadataSource } from '../../src/metadata/tmdb-metadata-resolver.js';

const fixture = (name: string) =>
  readFile(new URL(`../fixtures/tmdb/${name}`, import.meta.url), 'utf8');

describe('TMDB metadata source', () => {
  it.each([
    {
      request: { type: 'movie' as const, id: 'tt0000011' },
      files: ['find-movie.json', 'movie-sk.json', 'movie-cs.json', 'movie-alternative-titles.json'],
      expected: { originalTitle: 'Hviezdne dobrodruzstvo', year: 1977 },
    },
    {
      request: { type: 'series' as const, id: 'tt0001399', season: 1, episode: 2 },
      files: [
        'find-series.json',
        'series-sk.json',
        'series-cs.json',
        'series-alternative-titles.json',
      ],
      expected: { originalTitle: 'Severne kralovstvo', year: 2011 },
    },
    {
      request: { type: 'series' as const, id: 'tmdb:1399', season: 1, episode: 2 },
      files: [
        'series-details.json',
        'series-sk.json',
        'series-cs.json',
        'series-alternative-titles.json',
      ],
      expected: { originalTitle: 'Severne kralovstvo', year: 2011 },
    },
    {
      request: { type: 'series' as const, id: 'tvdb:83757', season: 1, episode: 2 },
      files: [
        'find-series.json',
        'series-sk.json',
        'series-cs.json',
        'series-alternative-titles.json',
      ],
      expected: { originalTitle: 'Severne kralovstvo', year: 2011 },
    },
  ])(
    'resolves original, localized and bounded alternative titles',
    async ({ request, files, expected }) => {
      const bodies = await Promise.all(files.map(fixture));
      const fetchMock = vi.fn<typeof fetch>();
      for (const body of bodies) {
        fetchMock.mockResolvedValueOnce(
          new Response(body, { headers: { 'content-type': 'application/json' } }),
        );
      }
      const source = createTmdbMetadataSource(
        createTmdbClient({ accessToken: 'sanitized-user-token', fetch: fetchMock }),
      );

      const metadata = await source.lookup(request, {
        signal: new AbortController().signal,
        correlationId: 'fixture-correlation',
      });

      expect(metadata).toMatchObject(expected);
      expect(metadata?.slovakTitle).toBeTruthy();
      expect(metadata?.czechTitle).toBeTruthy();
      expect(metadata?.alternativeTitles.length).toBeLessThanOrEqual(8);
      if (request.type === 'movie') {
        expect(metadata?.alternativeTitles).toContain('Sanitized Japanese title');
      }
      expect(fetchMock).toHaveBeenCalledTimes(4);
    },
  );

  it('keeps a romanized JP alias inside the bounded alternative title list', async () => {
    const client: TmdbClient = {
      validateAuthentication: vi.fn().mockResolvedValue(undefined),
      findByImdbId: vi.fn().mockResolvedValue({
        id: 117465,
        originalTitle: '地獄楽',
        title: "Hell's Paradise",
        year: 2023,
      }),
      findByTvdbId: vi.fn().mockResolvedValue(undefined),
      getById: vi.fn(),
      getLocalizedTitle: vi
        .fn()
        .mockResolvedValueOnce('地獄楽')
        .mockResolvedValueOnce('Pekelný ráj'),
      getAlternativeTitles: vi.fn().mockResolvedValue([
        ...Array.from({ length: 10 }, (_, index) => ({
          country: 'US',
          title: `English alternative ${String(index + 1)}`,
        })),
        { country: 'JP', title: 'Jigokuraku' },
        { country: 'CN', title: '地狱乐' },
      ]),
    };
    const source = createTmdbMetadataSource(client);

    const metadata = await source.lookup(
      { type: 'series', id: 'tt13911284', season: 2, episode: 9 },
      { signal: new AbortController().signal, correlationId: 'anime-metadata' },
    );

    expect(metadata?.alternativeTitles).toContain('Jigokuraku');
    expect(metadata?.alternativeTitles).toHaveLength(8);
    expect(metadata?.alternativeTitles).not.toContain('地狱乐');
  });
});
