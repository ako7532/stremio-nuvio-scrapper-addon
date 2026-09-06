import { describe, expect, it } from 'vitest';

import { generateSearchQueries } from '../../src/metadata/search-query-generator.js';

describe('search query generation', () => {
  it('prioritizes localized movie titles and adds diacritic-free variants', () => {
    const queries = generateSearchQueries({
      type: 'movie',
      id: 'tt0167331',
      originalTitle: 'Cosy Dens',
      englishTitle: 'Cosy Dens',
      czechTitle: 'Pelíšky',
      slovakTitle: 'Pelíšky',
      alternativeTitles: ['Pelisky'],
      year: 1999,
    });

    expect(queries.map(({ value }) => value)).toEqual([
      'Pelíšky 1999',
      'pelisky 1999',
      'Cosy Dens 1999',
    ]);
    expect(queries.every((query) => query.type === 'movie')).toBe(true);
  });

  it('creates common episode forms and opt-in season-pack forms', () => {
    const queries = generateSearchQueries(
      {
        type: 'series',
        id: 'tt.example',
        originalTitle: 'The Bridge',
        czechTitle: 'Most',
        alternativeTitles: [],
        season: 1,
        episode: 4,
      },
      { includeSeasonPacks: true },
    );

    expect(queries.map(({ value }) => value)).toEqual([
      'Most S01E04',
      'Most S1E4',
      'Most 1x04',
      'Most S01',
      'Most Season 1',
      'The Bridge S01E04',
      'The Bridge S1E4',
      'The Bridge 1x04',
      'The Bridge S01',
      'The Bridge Season 1',
    ]);
  });

  it('does not search season packs unless explicitly enabled', () => {
    const queries = generateSearchQueries({
      type: 'series',
      id: 'tt.example',
      originalTitle: 'Dark',
      alternativeTitles: [],
      season: 2,
      episode: 3,
    });

    expect(queries.map(({ value }) => value)).toEqual(['Dark S02E03', 'Dark S2E3', 'Dark 2x03']);
    expect(queries.every((query) => query.type === 'series' && !query.seasonPack)).toBe(true);
  });
});
