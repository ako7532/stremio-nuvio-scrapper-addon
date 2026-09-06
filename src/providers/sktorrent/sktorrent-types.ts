export type SktorrentLanguage = 'cs' | 'sk' | 'en' | 'de' | 'hu' | 'pl' | 'unknown';

export type SktorrentListingResult = {
  id: string;
  title: string;
  category: string;
  language: SktorrentLanguage;
  sizeBytes: number;
  addedDate: string;
  seeders: number;
  leechers: number;
  detailUrl: string;
};

export type SktorrentFile = {
  name: string;
  sizeBytes: number;
};

export type SktorrentDetail = {
  id: string;
  title: string;
  category: string;
  language: SktorrentLanguage;
  sizeBytes: number;
  addedDate: string;
  seeders: number;
  leechers: number;
  genre?: string;
  files: readonly SktorrentFile[];
  declaredLanguage?: string;
  declaredSubtitles?: string;
  mediaInfo?: string;
  downloadPath: string;
  providerUrl: string;
};

export class SktorrentParserError extends Error {
  override readonly name = 'SktorrentParserError';
}
