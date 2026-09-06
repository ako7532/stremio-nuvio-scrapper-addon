import type { UserConfiguration } from '../domain/configuration.js';
import type { MediaRequest } from '../domain/media.js';
import type {
  FileProviderResult,
  ProviderResult,
  RankedResult,
  TorrentProviderResult,
} from '../domain/release.js';

export type StremioStream = {
  name: string;
  title: string;
  url?: string;
  infoHash?: string;
  behaviorHints?: { filename?: string };
};

export type WebsharePlaybackUrlFactory = (
  result: FileProviderResult,
  media?: MediaRequest,
) => string;
export type TorboxPlaybackUrlFactory = (
  result: TorrentProviderResult,
  media: MediaRequest,
) => string;

export function formatStreams(
  results: readonly RankedResult[],
  configuration: UserConfiguration,
  websharePlaybackUrl?: WebsharePlaybackUrlFactory,
  torboxPlaybackUrl?: TorboxPlaybackUrlFactory,
  media?: MediaRequest,
): readonly StremioStream[] {
  return results.flatMap(({ result }) => {
    const playback = playbackFields(
      result,
      configuration,
      websharePlaybackUrl,
      torboxPlaybackUrl,
      media,
    );
    if (playback === undefined) return [];
    return [{ ...displayFields(result, configuration.display.mode), ...playback }];
  });
}

function playbackFields(
  result: ProviderResult,
  configuration: UserConfiguration,
  websharePlaybackUrl: WebsharePlaybackUrlFactory | undefined,
  torboxPlaybackUrl: TorboxPlaybackUrlFactory | undefined,
  media: MediaRequest | undefined,
): Pick<StremioStream, 'url' | 'infoHash' | 'behaviorHints'> | undefined {
  if (result.provider === 'sktorrent') {
    if (configuration.providers.sktorrent.playbackMode === 'direct-torrent') {
      if (result.mediaType === 'series' && result.filename === undefined) return undefined;
      return {
        infoHash: result.infoHash,
        ...(result.filename === undefined ? {} : { behaviorHints: { filename: result.filename } }),
      };
    }
    if (torboxPlaybackUrl === undefined || media === undefined) return undefined;
    return {
      url: validatePlaybackUrl(torboxPlaybackUrl(result, media)),
      ...(result.filename === undefined ? {} : { behaviorHints: { filename: result.filename } }),
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
  mode: UserConfiguration['display']['mode'],
): Pick<StremioStream, 'name' | 'title'> {
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
    result.provider === 'sktorrent' ? 'SKTorrent' : 'Webshare',
    result.seeders === undefined ? undefined : `S:${result.seeders.toString()}`,
    result.provider === 'sktorrent' && result.cacheStatus !== 'unknown'
      ? result.cacheStatus
      : undefined,
  ].filter((value): value is string => value !== undefined && value.length > 0);

  return {
    name: `CZ/SK ${parsed?.resolution ?? ''}`.trim(),
    title:
      mode === 'compact'
        ? [firstLine, ...details].filter(Boolean).join(' • ')
        : `${firstLine}\n${details.join(' • ')}`.trim(),
  };
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
