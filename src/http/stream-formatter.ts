import type { UserConfiguration } from '../domain/configuration.js';
import type { MediaRequest } from '../domain/media.js';
import type {
  FileProviderResult,
  ProviderResult,
  RankedResult,
  TorrentProviderResult,
} from '../domain/release.js';
import { isTorrentProviderResult } from '../domain/release.js';

export type StremioStream = {
  type?: MediaRequest['type'];
  name: string;
  title: string;
  url?: string;
  infoHash?: string;
  behaviorHints?: {
    filename?: string;
    notWebReady?: boolean;
    videoSize?: number;
  };
};

export type WebsharePlaybackUrlFactory = (
  result: FileProviderResult,
  media?: MediaRequest,
) => string;
export type TorboxPlaybackUrlFactory = (
  result: TorrentProviderResult,
  media: MediaRequest,
  candidates: readonly RankedResult[],
  configuration: UserConfiguration,
) => string;

export function formatStreams(
  results: readonly RankedResult[],
  configuration: UserConfiguration,
  websharePlaybackUrl?: WebsharePlaybackUrlFactory,
  torboxPlaybackUrl?: TorboxPlaybackUrlFactory,
  media?: MediaRequest,
  precacheCandidates: readonly RankedResult[] = results,
): readonly StremioStream[] {
  return results.flatMap(({ result }) => {
    const playback = playbackFields(
      result,
      configuration,
      websharePlaybackUrl,
      torboxPlaybackUrl,
      media,
      precacheCandidates,
    );
    if (playback === undefined) return [];
    return [{ ...displayFields(result, configuration), ...playback }];
  });
}

function playbackFields(
  result: ProviderResult,
  configuration: UserConfiguration,
  websharePlaybackUrl: WebsharePlaybackUrlFactory | undefined,
  torboxPlaybackUrl: TorboxPlaybackUrlFactory | undefined,
  media: MediaRequest | undefined,
  rankedResults: readonly RankedResult[],
): Pick<StremioStream, 'type' | 'url' | 'infoHash' | 'behaviorHints'> | undefined {
  if (isTorrentProviderResult(result)) {
    if (torrentPlaybackMode(result, configuration) === 'direct-torrent') {
      if (result.mediaType === 'series' && result.filename === undefined) return undefined;
      return {
        infoHash: result.infoHash,
        ...(result.filename === undefined ? {} : { behaviorHints: { filename: result.filename } }),
      };
    }
    if (torboxPlaybackUrl === undefined || media === undefined) return undefined;
    return {
      type: media.type,
      url: validatePlaybackUrl(torboxPlaybackUrl(result, media, rankedResults, configuration)),
      behaviorHints: {
        filename: result.filename ?? result.releaseName,
        notWebReady: true,
        ...(result.sizeBytes === undefined ? {} : { videoSize: result.sizeBytes }),
      },
    };
  }
  if (websharePlaybackUrl === undefined) return undefined;
  return {
    url: validatePlaybackUrl(websharePlaybackUrl(result, media)),
    ...(result.filename === undefined ? {} : { behaviorHints: { filename: result.filename } }),
  };
}

function displayFields(
  result: ProviderResult,
  configuration: UserConfiguration,
): Pick<StremioStream, 'name' | 'title'> {
  const mode = configuration.display.mode;
  const parsed = result.parsed;
  const technical = [
    parsed?.resolution === undefined || parsed.resolution === 'unknown'
      ? undefined
      : `🎞️ ${resolutionLabel[parsed.resolution]}`,
    parsed?.source === undefined || parsed.source === 'unknown'
      ? undefined
      : `📺 ${sourceLabel[parsed.source]}`,
    parsed?.videoCodec === undefined || parsed.videoCodec === 'unknown'
      ? undefined
      : `🎥 ${parsed.videoCodec.toUpperCase()}`,
    parsed?.dynamicRange === undefined || parsed.dynamicRange === 'unknown'
      ? undefined
      : `🌈 ${dynamicRangeLabel[parsed.dynamicRange]}`,
  ].filter((value): value is string => value !== undefined);
  const audioLanguages = parsed?.languages.audio ?? [];
  const subtitleLanguages = parsed?.languages.subtitles ?? [];
  const size = formatSize(result.sizeBytes);
  const languageSummary = formatLanguages(audioLanguages);
  const firstLine = [
    languageSummary === undefined ? undefined : `🎧 ${languageSummary}`,
    ...technical,
  ]
    .filter((value): value is string => value !== undefined)
    .join(' • ');
  const details = [
    size === undefined ? undefined : `💾 ${size}`,
    formatAudio(parsed?.audioCodecs ?? [], parsed?.audioChannels),
    subtitleLanguages.length === 0
      ? undefined
      : `💬 ${formatLanguages(subtitleLanguages) ?? ''} subtitles`,
    result.seeders === undefined ? undefined : `🌱 ${result.seeders.toString()}`,
  ].filter((value): value is string => value !== undefined && value.length > 0);
  const playback = playbackStatus(result, configuration);
  const provider = `${providerIcon[result.provider]} ${providerLabel[result.provider]}`;
  const resolution = parsed?.resolution === 'unknown' ? undefined : parsed?.resolution;
  const summary = [firstLine, ...details, playback].filter(Boolean).join(' • ');

  return {
    name: [provider, resolution === undefined ? undefined : resolutionLabel[resolution]]
      .filter(Boolean)
      .join(' • '),
    title:
      mode === 'compact'
        ? [result.releaseName, summary].filter(Boolean).join('\n')
        : [result.releaseName, firstLine, details.join(' • '), playback].filter(Boolean).join('\n'),
  };
}

const providerLabel: Readonly<Record<ProviderResult['provider'], string>> = {
  sktorrent: 'SKTorrent',
  webshare: 'Webshare',
  indexers: 'Indexers',
};

const providerIcon: Readonly<Record<ProviderResult['provider'], string>> = {
  sktorrent: '🇸🇰',
  webshare: '☁️',
  indexers: '🧲',
};

const resolutionLabel = {
  '2160p': '4K',
  '1440p': '1440p',
  '1080p': '1080p',
  '720p': '720p',
  '576p': '576p',
  '480p': '480p',
} as const;

const sourceLabel = {
  remux: 'REMUX',
  bluray: 'BLURAY',
  'web-dl': 'WEB-DL',
  webrip: 'WEBRIP',
  hdtv: 'HDTV',
  dvdrip: 'DVDRIP',
  dvd: 'DVD',
  cam: 'CAM',
  ts: 'TS',
} as const;

const dynamicRangeLabel = {
  'dolby-vision': 'DOLBY VISION',
  'hdr10-plus': 'HDR10+',
  hdr10: 'HDR10',
  hlg: 'HLG',
  sdr: 'SDR',
} as const;

const languageLabel: Readonly<Record<string, string>> = {
  sk: '🇸🇰 SK',
  cs: '🇨🇿 CZ',
  en: '🇬🇧 EN',
  pl: '🇵🇱 PL',
  de: '🇩🇪 DE',
};

const audioCodecLabel: Readonly<Record<string, string>> = {
  truehd: 'TRUEHD',
  atmos: 'ATMOS',
  'dts-x': 'DTS:X',
  'dts-hd-ma': 'DTS-HD MA',
  dts: 'DTS',
  eac3: 'EAC3',
  ac3: 'AC3',
  aac: 'AAC',
};

const torrentPlaybackMode = (
  result: TorrentProviderResult,
  configuration: UserConfiguration,
): 'direct-torrent' | 'torbox-only' =>
  result.provider === 'sktorrent' ? configuration.providers.sktorrent.playbackMode : 'torbox-only';

function playbackStatus(result: ProviderResult, configuration: UserConfiguration): string {
  if (!isTorrentProviderResult(result)) return '☁️ Direct stream';
  if (torrentPlaybackMode(result, configuration) === 'direct-torrent') return '🧲 Direct P2P';
  if (result.cacheStatus === 'cached') return '⚡ TorBox • CACHED';
  if (result.cacheStatus === 'uncached') {
    return '⬇️ TorBox • UNCACHED • download starts after click';
  }
  return '❔ TorBox cache • checked after click';
}

function formatLanguages(languages: readonly string[]): string | undefined {
  const values = [...new Set(languages)].map(
    (language) => languageLabel[language] ?? `🌐 ${language.toUpperCase()}`,
  );
  return values.length === 0 ? undefined : values.join(' / ');
}

function formatAudio(codecs: readonly string[], channels: string | undefined): string | undefined {
  const values = codecs
    .filter((codec) => codec !== 'unknown')
    .map((codec) => audioCodecLabel[codec] ?? codec.toUpperCase());
  if (values.length === 0 && channels === undefined) return undefined;
  return `🔊 ${[values.join('/'), channels].filter(Boolean).join(' ')}`;
}

function formatSize(sizeBytes: number | undefined): string | undefined {
  if (sizeBytes === undefined) return undefined;
  const gibibytes = sizeBytes / 1_073_741_824;
  return gibibytes >= 0.1
    ? `${gibibytes.toFixed(1)} GB`
    : `${(sizeBytes / 1_048_576).toFixed(0)} MB`;
}

function validatePlaybackUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))
  ) {
    throw new TypeError('Playback URL must use HTTPS outside local development');
  }
  return url.toString();
}
