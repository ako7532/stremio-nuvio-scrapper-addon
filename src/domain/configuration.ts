import type { DynamicRange, Resolution, SourceType, VideoCodec } from './release.js';

export type TorboxPrecacheLimits = {
  minimumMatchScore?: number;
  minimumSeeders?: number;
  maximumTorrentSizeBytes?: number;
  maximumTotalSizeBytes?: number;
  allowedResolutions?: readonly Resolution[];
  preferredLanguagesOnly?: boolean;
};

export type LanguagePreferences = {
  preferred: readonly string[];
  allowed: readonly string[];
  excluded: readonly string[];
};

export type RankingFactor =
  | 'cached'
  | 'language'
  | 'resolution'
  | 'source'
  | 'hdr'
  | 'videoCodec'
  | 'audioQuality'
  | 'seeders'
  | 'size'
  | 'provider';

export type IndexerBackendType = 'prowlarr' | 'jackett';

export type IndexersConfiguration = {
  enabled: boolean;
  backend: IndexerBackendType;
  selectedIndexerIds: readonly string[];
};

export type UserConfiguration = {
  general?: {
    metadataLanguage: string;
  };
  providers: {
    sktorrent: {
      enabled: boolean;
      playbackMode: 'direct-torrent' | 'torbox-only';
    };
    webshare: { enabled: boolean };
    indexers?: IndexersConfiguration;
  };
  filters: {
    resolutions: readonly Resolution[];
    sources: readonly SourceType[];
    videoCodecs: readonly VideoCodec[];
    dynamicRanges: readonly DynamicRange[];
    minimumSizeBytes?: number;
    maximumSizeBytes?: number;
    minimumSeeders: number;
    includeTerms: readonly string[];
    excludeTerms: readonly string[];
  };
  languages: {
    mode: 'strict' | 'fallback';
    audio: LanguagePreferences;
    subtitles: LanguagePreferences;
  };
  ranking: readonly RankingFactor[];
  limits: {
    total: number;
    perResolution: Readonly<Partial<Record<Resolution, number>>>;
  };
  torbox: {
    showUncached: boolean;
    precacheCount: number;
    precacheLimits?: TorboxPrecacheLimits;
  };
  display: {
    mode: 'compact' | 'detailed';
  };
  advanced?: {
    providerTimeoutMs: number;
    safeDebug: boolean;
  };
};

export type ProviderCredentials = {
  tmdb?: { accessToken: string };
  sktorrent?: { username: string; password: string };
  webshare?: { username: string; password: string };
  torbox?: { apiKey: string };
  indexers?: { endpoint: string; apiKey: string };
};

export type CredentialProvider = keyof ProviderCredentials;

export const rankingFactors: readonly RankingFactor[] = [
  'cached',
  'language',
  'resolution',
  'source',
  'hdr',
  'videoCodec',
  'audioQuality',
  'seeders',
  'size',
  'provider',
];
