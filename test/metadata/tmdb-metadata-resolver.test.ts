import { readFile } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import { createTmdbClient } from '../../src/metadata/tmdb-client.js';
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
      expect(metadata?.alternativeTitles).toHaveLength(3);
      expect(metadata?.alternativeTitles).not.toContain('Sanitized Japanese title');
      expect(fetchMock).toHaveBeenCalledTimes(4);
    },
  );
});
