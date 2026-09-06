import type { MediaMetadata, SearchQuery } from '../domain/media.js';
import { normalizeTitle } from './title-normalizer.js';

export type SearchQueryOptions = {
  includeSeasonPacks?: boolean;
};

export function generateSearchQueries(
  metadata: MediaMetadata,
  options: SearchQueryOptions = {},
): readonly SearchQuery[] {
  const titles = uniqueTitles([
    metadata.czechTitle,
    metadata.slovakTitle,
    metadata.originalTitle,
    metadata.englishTitle,
    ...metadata.alternativeTitles,
  ]);
  const queries: SearchQuery[] = [];
  const seen = new Set<string>();

  for (const title of titles) {
    const variants = titleVariants(title);
    for (const variant of variants) {
      if (metadata.type === 'movie') {
        const value = joinQueryParts(variant, metadata.year?.toString());
        addUniqueQuery(queries, seen, {
          type: 'movie',
          value,
          title: variant,
          ...(metadata.year === undefined ? {} : { year: metadata.year }),
        });
        continue;
      }

      const episodeFormats = [
        `S${pad(metadata.season)}E${pad(metadata.episode)}`,
        `S${metadata.season.toString()}E${metadata.episode.toString()}`,
        `${metadata.season.toString()}x${pad(metadata.episode)}`,
      ];

      for (const episodeFormat of episodeFormats) {
        addUniqueQuery(queries, seen, {
          type: 'series',
          value: `${variant} ${episodeFormat}`,
          title: variant,
          season: metadata.season,
          episode: metadata.episode,
          seasonPack: false,
          ...(metadata.year === undefined ? {} : { year: metadata.year }),
        });
      }

      if (options.includeSeasonPacks === true) {
        for (const seasonFormat of [
          `S${pad(metadata.season)}`,
          `Season ${metadata.season.toString()}`,
        ]) {
          addUniqueQuery(queries, seen, {
            type: 'series',
            value: `${variant} ${seasonFormat}`,
            title: variant,
            season: metadata.season,
            seasonPack: true,
            ...(metadata.year === undefined ? {} : { year: metadata.year }),
          });
        }
      }
    }
  }

  return queries;
}

function uniqueTitles(values: readonly (string | undefined)[]): readonly string[] {
  const titles: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const title = value?.trim().replace(/\s+/gu, ' ');
    if (title === undefined || title === '') {
      continue;
    }

    const key = normalizeTitle(title);
    if (key !== '' && !seen.has(key)) {
      seen.add(key);
      titles.push(title);
    }
  }

  return titles;
}

function titleVariants(title: string): readonly string[] {
  const normalized = normalizeTitle(title);
  return normalized === title.toLocaleLowerCase('en-US') ? [title] : [title, normalized];
}

function addUniqueQuery(queries: SearchQuery[], seen: Set<string>, query: SearchQuery): void {
  const key = query.value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/gu, ' ').trim();
  if (!seen.has(key)) {
    seen.add(key);
    queries.push(query);
  }
}

function joinQueryParts(...parts: readonly (string | undefined)[]): string {
  return parts.filter((part): part is string => part !== undefined && part !== '').join(' ');
}

function pad(value: number): string {
  return value.toString().padStart(2, '0');
}
