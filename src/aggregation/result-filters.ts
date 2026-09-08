import type { LanguagePreferences, UserConfiguration } from '../domain/configuration.js';
import {
  isTorrentProviderResult,
  type ProviderResult,
  type RankedResult,
} from '../domain/release.js';

export function filterResults(
  candidates: readonly RankedResult[],
  configuration: UserConfiguration,
): readonly RankedResult[] {
  return candidates.filter(
    ({ result }) => getFilterRejectionReason(result, configuration) === undefined,
  );
}

export type FilterRejectionReason =
  | 'provider disabled'
  | 'webshare unavailable'
  | 'release unparsed'
  | 'resolution filtered'
  | 'source filtered'
  | 'video codec filtered'
  | 'dynamic range filtered'
  | 'below minimum size'
  | 'above maximum size'
  | 'below minimum seeders'
  | 'excluded term'
  | 'required term missing'
  | 'audio language filtered'
  | 'subtitle language filtered';

export function getFilterRejectionReason(
  result: ProviderResult,
  configuration: UserConfiguration,
): FilterRejectionReason | undefined {
  if (result.provider !== 'indexers' && !configuration.providers[result.provider].enabled) {
    return 'provider disabled';
  }
  if (result.provider === 'webshare' && (!result.available || !result.streamable)) {
    return 'webshare unavailable';
  }

  const parsed = result.parsed;
  if (parsed === undefined) return 'release unparsed';
  if (!configuration.filters.resolutions.includes(parsed.resolution)) return 'resolution filtered';
  if (!configuration.filters.sources.includes(parsed.source)) return 'source filtered';
  if (!configuration.filters.videoCodecs.includes(parsed.videoCodec)) return 'video codec filtered';
  if (!configuration.filters.dynamicRanges.includes(parsed.dynamicRange)) {
    return 'dynamic range filtered';
  }
  if (
    configuration.filters.minimumSizeBytes !== undefined &&
    (result.sizeBytes === undefined || result.sizeBytes < configuration.filters.minimumSizeBytes)
  ) {
    return 'below minimum size';
  }
  if (
    configuration.filters.maximumSizeBytes !== undefined &&
    (result.sizeBytes === undefined || result.sizeBytes > configuration.filters.maximumSizeBytes)
  ) {
    return 'above maximum size';
  }
  if (
    isTorrentProviderResult(result) &&
    (result.seeders ?? 0) < configuration.filters.minimumSeeders
  ) {
    return 'below minimum seeders';
  }

  const searchableText =
    `${result.title} ${result.releaseName} ${result.filename ?? ''}`.toLocaleLowerCase('en-US');
  const excludeTerms = configuration.filters.excludeTerms
    .map((term) => term.trim().toLocaleLowerCase('en-US'))
    .filter((term) => term.length > 0);
  if (excludeTerms.some((term) => searchableText.includes(term))) {
    return 'excluded term';
  }
  const includeTerms = configuration.filters.includeTerms
    .map((term) => term.trim().toLocaleLowerCase('en-US'))
    .filter((term) => term.length > 0);
  if (includeTerms.length > 0 && !includeTerms.some((term) => searchableText.includes(term))) {
    return 'required term missing';
  }

  if (
    !passesLanguageFilter(
      parsed.languages.audio,
      configuration.languages.audio,
      configuration.languages.mode,
    )
  ) {
    return 'audio language filtered';
  }
  if (
    !passesLanguageFilter(
      parsed.languages.subtitles,
      configuration.languages.subtitles,
      configuration.languages.mode,
    )
  ) {
    return 'subtitle language filtered';
  }
  return undefined;
}

function passesLanguageFilter(
  actual: readonly string[],
  preferences: LanguagePreferences,
  mode: UserConfiguration['languages']['mode'],
): boolean {
  if (actual.some((language) => preferences.excluded.includes(language))) return false;
  const accepted = [...preferences.preferred, ...preferences.allowed];
  return (
    mode === 'fallback' ||
    accepted.length === 0 ||
    actual.some((language) => accepted.includes(language))
  );
}
