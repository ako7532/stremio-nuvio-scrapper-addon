import { deduplicateResults } from '../aggregation/result-deduplicator.js';
import { filterResults } from '../aggregation/result-filters.js';
import { limitResults } from '../aggregation/result-limits.js';
import { rankResults } from '../aggregation/result-ranking.js';
import type { UserConfiguration } from '../domain/configuration.js';
import type { MediaRequest, SearchQuery } from '../domain/media.js';
import type { ProviderResult, RankedResult } from '../domain/release.js';
import {
  formatStreams,
  type StremioStream,
  type TorboxPlaybackUrlFactory,
  type WebsharePlaybackUrlFactory,
} from '../http/stream-formatter.js';
import { matchEpisode } from '../matching/episode-matcher.js';
import { matchMovie } from '../matching/movie-matcher.js';
import type { MetadataResolver } from '../metadata/metadata-resolver.js';
import { generateSearchQueries } from '../metadata/search-query-generator.js';
import type { StreamProvider } from '../providers/provider.js';

export type SearchStreamsContext = { signal: AbortSignal; correlationId: string };
export type SearchStreams = {
  search(request: MediaRequest, context: SearchStreamsContext): Promise<readonly StremioStream[]>;
};
export type CacheEnricher = (
  results: readonly RankedResult[],
  context: SearchStreamsContext,
) => Promise<readonly RankedResult[]>;

export type SearchStreamsDependencies = {
  metadataResolver: MetadataResolver;
  providers: readonly StreamProvider[];
  configuration: UserConfiguration;
  cacheEnricher?: CacheEnricher;
  websharePlaybackUrl?: WebsharePlaybackUrlFactory;
  torboxPlaybackUrl?: TorboxPlaybackUrlFactory;
};

export function createSearchStreams(dependencies: SearchStreamsDependencies): SearchStreams {
  return {
    async search(request, context) {
      const metadata = await dependencies.metadataResolver.resolve(request, context);
      const queries = generateSearchQueries(metadata, { includeSeasonPacks: true });
      const providerResults = await searchProviders(
        dependencies.providers,
        queries,
        dependencies.configuration,
        context,
      );
      const matched = providerResults.flatMap((result) => {
        const decision =
          metadata.type === 'movie' ? matchMovie(metadata, result) : matchEpisode(metadata, result);
        return decision.matched ? [{ result, matchScore: decision.score, rankValues: {} }] : [];
      });
      const filtered = filterResults(
        deduplicateResults(matched),
        dependencies.configuration,
      ).filter(({ result }) => isPlaybackCandidate(result, dependencies));
      const enriched =
        dependencies.cacheEnricher === undefined
          ? filtered
          : await dependencies.cacheEnricher(filtered, context);
      const ranked = rankResults(enriched, dependencies.configuration);
      const limited = limitResults(
        ranked.filter(({ result }) => isAvailableForPlayback(result, dependencies)),
        dependencies.configuration.limits,
      );
      return formatStreams(
        limited,
        dependencies.configuration,
        dependencies.websharePlaybackUrl,
        dependencies.torboxPlaybackUrl,
        request,
        ranked,
      );
    },
  };
}

function isPlaybackCandidate(
  result: ProviderResult,
  dependencies: SearchStreamsDependencies,
): boolean {
  if (result.provider === 'webshare') return dependencies.websharePlaybackUrl !== undefined;
  if (dependencies.configuration.providers.sktorrent.playbackMode === 'torbox-only') {
    return dependencies.torboxPlaybackUrl !== undefined && result.magnetUri !== undefined;
  }
  return result.mediaType !== 'series' || result.filename !== undefined;
}

function isAvailableForPlayback(
  result: ProviderResult,
  dependencies: SearchStreamsDependencies,
): boolean {
  if (
    result.provider !== 'sktorrent' ||
    dependencies.configuration.providers.sktorrent.playbackMode === 'direct-torrent'
  ) {
    return true;
  }
  if (result.cacheStatus === 'cached') return true;
  return result.cacheStatus === 'uncached' && dependencies.configuration.torbox.showUncached;
}

async function searchProviders(
  providers: readonly StreamProvider[],
  queries: readonly SearchQuery[],
  configuration: UserConfiguration,
  context: SearchStreamsContext,
): Promise<readonly ProviderResult[]> {
  const enabled = providers.filter((provider) => configuration.providers[provider.name].enabled);
  const providerSettlements = await Promise.allSettled(
    enabled.map(async (provider) => {
      const results: ProviderResult[] = [];
      for (const query of queries) {
        try {
          results.push(...(await provider.search(query, context)));
        } catch {
          context.signal.throwIfAborted();
        }
      }
      return results;
    }),
  );
  context.signal.throwIfAborted();
  return providerSettlements.flatMap((settlement) =>
    settlement.status === 'fulfilled' ? settlement.value : [],
  );
}
