import type { MediaType } from '../../domain/media.js';

export type TorznabSearchMode = 'search' | 'movie' | 'tvsearch';

export type TorznabCapabilities = {
  limits: { maximum: number; default: number };
  modes: Readonly<
    Record<TorznabSearchMode, { available: boolean; supportedParameters: readonly string[] }>
  >;
  categories: readonly number[];
};

export type TorznabQuery = {
  mode: TorznabSearchMode;
  parameters: Readonly<Record<string, string>>;
};

export type IndexerDiscoveryResult = {
  backendId: string;
  name: string;
  enabled: boolean;
  supportsSearch: boolean;
  protocol: 'torrent' | 'usenet' | 'unknown';
  privacy: 'public' | 'semi-private' | 'private' | 'unknown';
};

export type IndexerSearchResult = {
  indexerId: string;
  indexerName: string;
  releaseName: string;
  mediaType: MediaType;
  releaseGuid?: string;
  detailsUrl?: string;
  acquisitionReference?: string;
  infoHash?: string;
  magnetUri?: string;
  sizeBytes?: number;
  seeders?: number;
};
