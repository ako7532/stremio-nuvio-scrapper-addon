import type {
  LanguagePreferences,
  RankingFactor,
  UserConfiguration,
} from '../domain/configuration.js';
import {
  isTorrentProviderResult,
  type AudioCodec,
  type ProviderName,
  type ProviderResult,
  type RankedResult,
} from '../domain/release.js';

const resolutionValue = {
  unknown: 0,
  '480p': 1,
  '576p': 2,
  '720p': 3,
  '1080p': 4,
  '1440p': 5,
  '2160p': 6,
} as const;
const sourceValue = {
  unknown: 0,
  cam: 1,
  ts: 2,
  dvd: 3,
  dvdrip: 4,
  hdtv: 5,
  webrip: 6,
  'web-dl': 7,
  bluray: 8,
  remux: 9,
} as const;
const dynamicRangeValue = {
  unknown: 0,
  sdr: 1,
  hlg: 2,
  hdr10: 3,
  'hdr10-plus': 4,
  'dolby-vision': 5,
} as const;
const videoCodecValue = { unknown: 0, avc: 1, hevc: 2, av1: 3 } as const;
const audioCodecValue: Readonly<Record<AudioCodec, number>> = {
  unknown: 0,
  aac: 1,
  ac3: 2,
  eac3: 3,
  dts: 4,
  'dts-hd-ma': 5,
  'dts-x': 6,
  truehd: 7,
  atmos: 8,
};

export function rankResults(
  candidates: readonly RankedResult[],
  configuration: UserConfiguration,
): readonly RankedResult[] {
  return candidates
    .map((candidate) => ({
      ...candidate,
      rankValues: buildRankValues(candidate.result, configuration),
    }))
    .sort((left, right) => compareRankedResults(left, right, configuration.ranking));
}

function buildRankValues(
  result: ProviderResult,
  configuration: UserConfiguration,
): Readonly<Record<RankingFactor, number>> {
  const parsed = result.parsed;
  return {
    cached: isTorrentProviderResult(result) ? cacheValue(result.cacheStatus) : 1,
    language:
      parsed === undefined
        ? 0
        : Math.max(
            languageValue(parsed.languages.audio, configuration.languages.audio),
            languageValue(parsed.languages.subtitles, configuration.languages.subtitles),
          ),
    resolution: parsed === undefined ? 0 : resolutionValue[parsed.resolution],
    source: parsed === undefined ? 0 : sourceValue[parsed.source],
    hdr: parsed === undefined ? 0 : dynamicRangeValue[parsed.dynamicRange],
    videoCodec: parsed === undefined ? 0 : videoCodecValue[parsed.videoCodec],
    audioQuality:
      parsed === undefined
        ? 0
        : Math.max(0, ...parsed.audioCodecs.map((codec) => audioCodecValue[codec])),
    seeders: result.seeders ?? -1,
    size: result.sizeBytes ?? -1,
    provider: providerValue[result.provider],
  };
}

const providerValue: Readonly<Record<ProviderName, number>> = {
  sktorrent: 2,
  webshare: 1,
  indexers: 0,
};

function compareRankedResults(
  left: RankedResult,
  right: RankedResult,
  factors: readonly RankingFactor[],
): number {
  for (const factor of factors) {
    const difference = (right.rankValues[factor] ?? 0) - (left.rankValues[factor] ?? 0);
    if (difference !== 0) return difference;
  }
  if (right.matchScore !== left.matchScore) return right.matchScore - left.matchScore;
  const providerDifference = left.result.provider.localeCompare(right.result.provider, 'en');
  return providerDifference !== 0
    ? providerDifference
    : left.result.id.localeCompare(right.result.id, 'en');
}

function cacheValue(status: 'cached' | 'uncached' | 'unknown'): number {
  if (status === 'cached') return 2;
  return status === 'unknown' ? 1 : 0;
}

function languageValue(actual: readonly string[], preferences: LanguagePreferences): number {
  let best = 0;
  for (const language of actual) {
    const preferredIndex = preferences.preferred.indexOf(language);
    if (preferredIndex >= 0) best = Math.max(best, 1_000 - preferredIndex);
    else if (preferences.allowed.includes(language)) best = Math.max(best, 1);
  }
  return best;
}
