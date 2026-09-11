import { describe, expect, it } from 'vitest';

import type { MediaMetadata } from '../../../src/domain/media.js';
import { planIndexerQueries } from '../../../src/providers/indexers/indexer-query-planner.js';
import type { TorznabCapabilities } from '../../../src/providers/indexers/indexer-types.js';

const capabilities: TorznabCapabilities = {
  limits: { maximum: 100, default: 50 },
  modes: {
    search: { available: true, supportedParameters: ['q'] },
    movie: { available: true, supportedParameters: ['q', 'imdbid', 'year'] },
    tvsearch: {
      available: true,
      supportedParameters: ['q', 'imdbid', 'season', 'ep'],
    },
  },
  categories: [2000, 5000],
};

describe('Indexers query planner', () => {
  it('prefers IMDb movie search and keeps title fallbacks bounded', () => {
    const metadata: MediaMetadata = {
      type: 'movie',
      id: 'tt1234567',
      imdbId: 'tt1234567',
      originalTitle: 'Original',
      englishTitle: 'English',
      alternativeTitles: [],
      year: 2024,
    };

    expect(planIndexerQueries(metadata, capabilities)).toEqual([
      { mode: 'movie', parameters: { imdbid: 'tt1234567' } },
      { mode: 'movie', parameters: { q: 'English', year: '2024' } },
      { mode: 'movie', parameters: { q: 'Original', year: '2024' } },
    ]);
  });

  it('uses structured TV search and a generic SxxExx fallback without unsupported parameters', () => {
    const metadata: MediaMetadata = {
      type: 'series',
      id: 'tt7654321',
      imdbId: 'tt7654321',
      originalTitle: 'Fixture Show',
      alternativeTitles: [],
      season: 2,
      episode: 3,
    };
    const limited: TorznabCapabilities = {
      ...capabilities,
      modes: {
        ...capabilities.modes,
        tvsearch: { available: true, supportedParameters: ['q', 'season', 'ep'] },
      },
    };

    expect(planIndexerQueries(metadata, limited)).toEqual([
      {
        mode: 'tvsearch',
        parameters: { q: 'Fixture Show', season: '2', ep: '3' },
      },
      { mode: 'search', parameters: { q: 'Fixture Show S02E03' } },
    ]);
  });
});
