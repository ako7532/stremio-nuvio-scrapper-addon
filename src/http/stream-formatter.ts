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
    parsed?.resolution,
    parsed?.source === 'unknown' ? undefined : parsed?.source.toUpperCase(),
    parsed?.videoCodec === 'unknown' ? undefined : parsed?.videoCodec.toUpperCase(),
    parsed?.dynamicRange === 'unknown' ? undefined : parsed?.dynamicRange.toUpperCase(),
  ].filter((value): value is string => value !== undefined);
  const audioLanguages = parsed?.languages.audio ?? [];
  const subtitleLanguages = parsed?.languages.subtitles ?? [];
  const firstLine = [
    ...new Set(audioLanguages.map((language) => language.toUpperCase())),
    ...technical,
  ].join(' ');
  const details = [
    formatSize(result.sizeBytes),
    parsed?.audioCodecs
      .filter((codec) => codec !== 'unknown')
      .map((codec) => codec.toUpperCase())
      .join('/'),
    subtitleLanguages.length === 0
      ? undefined
      : `${[...new Set(subtitleLanguages.map((language) => language.toUpperCase()))].join('/')} subs`,
    result.seeders === undefined ? undefined : `S:${result.seeders.toString()}`,
    isTorrentProviderResult(result) && result.cacheStatus === 'cached' ? 'cached' : undefined,
    isTorrentProviderResult(result) &&
    torrentPlaybackMode(result, configuration) === 'torbox-only' &&
    result.cacheStatus === 'uncached'
      ? '⏳ TorBox download required — open once, then retry'
      : undefined,
  ].filter((value): value is string => value !== undefined && value.length > 0);
  const provider = providerLabel[result.provider];
  const resolution = parsed?.resolution === 'unknown' ? undefined : parsed?.resolution;
  const summary = [firstLine, ...details].filter(Boolean).join(' • ');

  return {
    name: [provider, resolution].filter(Boolean).join(' '),
    title:
      mode === 'compact'
        ? [result.releaseName, summary].filter(Boolean).join('\n')
        : [result.releaseName, firstLine, details.join(' • ')].filter(Boolean).join('\n'),
  };
}

const providerLabel: Readonly<Record<ProviderResult['provider'], string>> = {
  sktorrent: 'SKTorrent',
  webshare: 'Webshare',
  indexers: 'Indexers',
};

const torrentPlaybackMode = (
  result: TorrentProviderResult,
  configuration: UserConfiguration,
): 'direct-torrent' | 'torbox-only' =>
  result.provider === 'sktorrent' ? configuration.providers.sktorrent.playbackMode : 'torbox-only';

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
