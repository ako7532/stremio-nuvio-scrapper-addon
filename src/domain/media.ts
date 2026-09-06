export const mediaTypes = ['movie', 'series'] as const;
export type MediaType = (typeof mediaTypes)[number];

export type MediaRequest = {
  type: MediaType;
  id: string;
  season?: number;
  episode?: number;
};

export type MediaMetadata = MediaRequest & {
  originalTitle: string;
  englishTitle?: string;
  czechTitle?: string;
  slovakTitle?: string;
  alternativeTitles: readonly string[];
  year?: number;
};

export type SearchQuery = {
  value: string;
  title: string;
  year?: number;
  season?: number;
  episode?: number;
};
