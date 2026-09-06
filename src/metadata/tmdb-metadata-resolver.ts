import type { MediaMetadata } from '../domain/media.js';
import type { MetadataSource } from './metadata-resolver.js';
import type { TmdbClient } from './tmdb-client.js';
import { TmdbTransportError } from './tmdb-client.js';

export const createTmdbMetadataSource = (client: TmdbClient): MetadataSource => ({
  name: 'tmdb',
  async lookup(request, context): Promise<MediaMetadata | undefined> {
    let found;
    try {
      found = await client.findByImdbId(request, context.signal);
    } catch (error) {
      if (error instanceof TmdbTransportError && error.kind === 'not-found') return undefined;
      throw error;
    }
    if (found === undefined) return undefined;
    const [slovakTitle, czechTitle, alternativeTitles] = await Promise.all([
      client.getLocalizedTitle(request.type, found.id, 'sk-SK', context.signal),
      client.getLocalizedTitle(request.type, found.id, 'cs-CZ', context.signal),
      client.getAlternativeTitles(request.type, found.id, context.signal),
    ]);
    const alternatives = uniqueTitles(
      [
        found.title,
        ...alternativeTitles
          .filter(
            ({ country }) => country === undefined || ['SK', 'CZ', 'US', 'GB'].includes(country),
          )
          .map(({ title }) => title),
      ],
      found.originalTitle,
      slovakTitle,
      czechTitle,
    );
    return {
      ...request,
      originalTitle: found.originalTitle,
      englishTitle: found.title,
      slovakTitle,
      czechTitle,
      alternativeTitles: alternatives,
      ...(found.year === undefined ? {} : { year: found.year }),
    };
  },
});

const uniqueTitles = (
  values: readonly string[],
  ...primary: readonly string[]
): readonly string[] => {
  const excluded = new Set(primary.map(normalize));
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = normalize(value);
    if (key.length === 0 || excluded.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const normalize = (value: string): string => value.trim().toLocaleLowerCase('en');
