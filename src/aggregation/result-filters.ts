import type { LanguagePreferences, UserConfiguration } from '../domain/configuration.js';
import type { ProviderResult, RankedResult } from '../domain/release.js';

export function filterResults(
  candidates: readonly RankedResult[],
  configuration: UserConfiguration,
): readonly RankedResult[] {
  return candidates.filter(({ result }) => passesFilters(result, configuration));
}

function passesFilters(result: ProviderResult, configuration: UserConfiguration): boolean {
  if (!configuration.providers[result.provider].enabled) return false;
  if (result.provider === 'webshare' && (!result.available || !result.streamable)) return false;

  const parsed = result.parsed;
  if (parsed === undefined) return false;
  if (!configuration.filters.resolutions.includes(parsed.resolution)) return false;
  if (!configuration.filters.sources.includes(parsed.source)) return false;
  if (!configuration.filters.videoCodecs.includes(parsed.videoCodec)) return false;
  if (!configuration.filters.dynamicRanges.includes(parsed.dynamicRange)) return false;
  if (
    configuration.filters.minimumSizeBytes !== undefined &&
    (result.sizeBytes === undefined || result.sizeBytes < configuration.filters.minimumSizeBytes)
  ) {
    return false;
  }
  if (
    configuration.filters.maximumSizeBytes !== undefined &&
    (result.sizeBytes === undefined || result.sizeBytes > configuration.filters.maximumSizeBytes)
  ) {
    return false;
  }
  if (
    result.provider === 'sktorrent' &&
    (result.seeders ?? 0) < configuration.filters.minimumSeeders
  ) {
    return false;
  }

  const searchableText =
    `${result.title} ${result.releaseName} ${result.filename ?? ''}`.toLocaleLowerCase('en-US');
  const excludeTerms = configuration.filters.excludeTerms
    .map((term) => term.trim().toLocaleLowerCase('en-US'))
    .filter((term) => term.length > 0);
  if (excludeTerms.some((term) => searchableText.includes(term))) {
    return false;
  }
  const includeTerms = configuration.filters.includeTerms
    .map((term) => term.trim().toLocaleLowerCase('en-US'))
    .filter((term) => term.length > 0);
  if (includeTerms.length > 0 && !includeTerms.some((term) => searchableText.includes(term))) {
    return false;
  }

  return (
    passesLanguageFilter(
      parsed.languages.audio,
      configuration.languages.audio,
      configuration.languages.mode,
    ) &&
    passesLanguageFilter(
      parsed.languages.subtitles,
      configuration.languages.subtitles,
      configuration.languages.mode,
    )
  );
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
