import type { CacheStatus } from '../../domain/release.js';

export type TorboxCacheEntry = {
  hash: string;
  status: CacheStatus;
};

export type TorboxTorrentFile = {
  id: number;
  name: string;
  sizeBytes?: number;
};

export type TorboxTorrent = {
  id: number;
  hash: string;
  name: string;
  downloadState: string;
  files: readonly TorboxTorrentFile[];
};

export type TorboxCreatedTorrent = {
  id: number;
  hash?: string;
};
