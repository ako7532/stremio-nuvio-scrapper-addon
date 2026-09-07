export const mediaTypes = ['movie', 'series'] as const;
export type MediaType = (typeof mediaTypes)[number];

export type MovieRequest = {
  type: 'movie';
  id: string;
};

export type SeriesRequest = {
  type: 'series';
  id: string;
  season: number;
  episode: number;
};

export type MediaRequest = MovieRequest | SeriesRequest;

type MetadataTitles = {
  originalTitle: string;
  englishTitle?: string;
  czechTitle?: string;
  slovakTitle?: string;
  alternativeTitles: readonly string[];
  year?: number;
};

export type MediaMetadata = MediaRequest & MetadataTitles;

type SearchQueryBase = {
  value: string;
  title: string;
  year?: number;
  fallback?: boolean;
  broad?: boolean;
};

export type SearchQuery =
  | (SearchQueryBase & { type: 'movie' })
  | (SearchQueryBase & {
      type: 'series';
      season: number;
      episode?: number;
      seasonPack: boolean;
    });
