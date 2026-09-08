import type { MediaMetadata } from '../../domain/media.js';
import type { TorznabCapabilities, TorznabQuery, TorznabSearchMode } from './indexer-types.js';

const MAXIMUM_QUERIES = 4;

export const planIndexerQueries = (
  metadata: MediaMetadata,
  capabilities: TorznabCapabilities,
): readonly TorznabQuery[] => {
  const queries: TorznabQuery[] = [];
  const titles = uniqueTitles([metadata.englishTitle, metadata.originalTitle]);
  const primaryTitle = titles[0] ?? metadata.originalTitle;

  if (metadata.type === 'movie') {
    if (metadata.imdbId !== undefined && supports(capabilities, 'movie', 'imdbid')) {
      add(queries, { mode: 'movie', parameters: { imdbid: metadata.imdbId } });
    }
    for (const title of titles) {
      if (available(capabilities, 'movie') && supports(capabilities, 'movie', 'q')) {
        add(queries, {
          mode: 'movie',
          parameters: {
            q: title,
            ...(metadata.year !== undefined && supports(capabilities, 'movie', 'year')
              ? { year: String(metadata.year) }
              : {}),
          },
        });
      } else if (supports(capabilities, 'search', 'q')) {
        add(queries, {
          mode: 'search',
          parameters: { q: [title, metadata.year].filter(Boolean).join(' ') },
        });
      }
    }
  } else {
    if (
      metadata.imdbId !== undefined &&
      supports(capabilities, 'tvsearch', 'imdbid') &&
      supports(capabilities, 'tvsearch', 'season') &&
      supports(capabilities, 'tvsearch', 'ep')
    ) {
      add(queries, {
        mode: 'tvsearch',
        parameters: {
          imdbid: metadata.imdbId,
          season: String(metadata.season),
          ep: String(metadata.episode),
        },
      });
    }
    if (
      supports(capabilities, 'tvsearch', 'q') &&
      supports(capabilities, 'tvsearch', 'season') &&
      supports(capabilities, 'tvsearch', 'ep')
    ) {
      add(queries, {
        mode: 'tvsearch',
        parameters: {
          q: primaryTitle,
          season: String(metadata.season),
          ep: String(metadata.episode),
        },
      });
    }
    if (supports(capabilities, 'search', 'q')) {
      for (const title of titles) {
        add(queries, {
          mode: 'search',
          parameters: {
            q: `${title} S${pad(metadata.season)}E${pad(metadata.episode)}`,
          },
        });
      }
    }
  }
  return queries.slice(0, MAXIMUM_QUERIES);
};

const available = (capabilities: TorznabCapabilities, mode: TorznabSearchMode): boolean =>
  capabilities.modes[mode].available;

const supports = (
  capabilities: TorznabCapabilities,
  mode: TorznabSearchMode,
  parameter: string,
): boolean =>
  available(capabilities, mode) && capabilities.modes[mode].supportedParameters.includes(parameter);

const add = (queries: TorznabQuery[], query: TorznabQuery): void => {
  const key = `${query.mode}:${new URLSearchParams(query.parameters).toString()}`;
  if (
    !queries.some(
      (candidate) =>
        `${candidate.mode}:${new URLSearchParams(candidate.parameters).toString()}` === key,
    )
  ) {
    queries.push(query);
  }
};

const uniqueTitles = (values: readonly (string | undefined)[]): readonly string[] => {
  const seen = new Set<string>();
  return values.filter((value): value is string => {
    if (value === undefined) return false;
    const key = value.trim().toLocaleLowerCase('en-US');
    if (key.length === 0 || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const pad = (value: number): string => String(value).padStart(2, '0');
