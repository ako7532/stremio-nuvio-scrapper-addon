import type { MediaType } from './media.js';

export const resolutions = ['2160p', '1440p', '1080p', '720p', '576p', '480p', 'unknown'] as const;
export type Resolution = (typeof resolutions)[number];

export const sourceTypes = [
  'remux',
  'bluray',
  'web-dl',
  'webrip',
  'hdtv',
  'dvdrip',
  'dvd',
  'cam',
  'ts',
  'unknown',
] as const;
export type SourceType = (typeof sourceTypes)[number];

export const videoCodecs = ['av1', 'hevc', 'avc', 'unknown'] as const;
export type VideoCodec = (typeof videoCodecs)[number];

export const dynamicRanges = [
  'dolby-vision',
  'hdr10-plus',
  'hdr10',
  'hlg',
  'sdr',
  'unknown',
] as const;
export type DynamicRange = (typeof dynamicRanges)[number];

export const audioCodecs = [
  'truehd',
  'atmos',
  'dts-x',
  'dts-hd-ma',
  'dts',
  'eac3',
  'ac3',
  'aac',
  'unknown',
] as const;
export type AudioCodec = (typeof audioCodecs)[number];

export type LanguageInfo = {
  audio: readonly string[];
  subtitles: readonly string[];
  confidence: number;
};

export type ParsedRelease = {
  resolution: Resolution;
  source: SourceType;
  videoCodec: VideoCodec;
  dynamicRange: DynamicRange;
  audioCodec: AudioCodec;
  audioChannels?: string;
  languages: LanguageInfo;
  releaseGroup?: string;
  confidence: number;
};

export type CacheStatus = 'cached' | 'uncached' | 'unknown';
export type ProviderName = 'sktorrent' | 'webshare';
export type ProviderSource = 'torrent' | 'file-hosting';

type ProviderResultBase = {
  provider: ProviderName;
  id: string;
  title: string;
  releaseName: string;
  mediaType: MediaType;
  season?: number;
  episode?: number;
  year?: number;
  filename?: string;
  sizeBytes?: number;
  seeders?: number;
  providerUrl: string;
  parsed?: ParsedRelease;
  parsedConfidence?: number;
};

export type TorrentProviderResult = ProviderResultBase & {
  provider: 'sktorrent';
  source: 'torrent';
  infoHash: string;
  magnetUri?: string;
  cacheStatus: CacheStatus;
};

export type FileProviderResult = ProviderResultBase & {
  provider: 'webshare';
  source: 'file-hosting';
  fileId: string;
  available: boolean;
  streamable: boolean;
};

export type ProviderResult = TorrentProviderResult | FileProviderResult;

export type RankedResult = {
  result: ProviderResult;
  matchScore: number;
  rankValues: Readonly<Record<string, number>>;
};
