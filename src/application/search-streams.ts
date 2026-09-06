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
import type { CacheObserver } from '../infrastructure/cache-observer.js';
import { classifyApplicationError } from './application-error.js';
import {
  applyProviderExecutionPolicy,
  type ProviderExecutionPolicyOptions,
} from './provider-execution-policy.js';
import {
  createCachedMetadataResolver,
  createCachedStreamProvider,
  type SearchCacheOptions,
} from './search-cache.js';
import { observeSearch, type SearchObserver } from './search-observability.js';

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
  observer?: SearchObserver;
  clock?: () => number;
  caching?:
    | false
    | {
        metadata?: SearchCacheOptions;
        provider?: SearchCacheOptions;
      };
  providerExecutionPolicy?: false | ProviderExecutionPolicyOptions;
};

export function createSearchStreams(dependencies: SearchStreamsDependencies): SearchStreams {
  const clock = dependencies.clock ?? Date.now;
  const cacheObserver: CacheObserver = (event) => {
    observeSearch(dependencies.observer, { type: 'cache', ...event });
  };
  const metadataResolver =
    dependencies.caching === false
      ? dependencies.metadataResolver
      : createCachedMetadataResolver(dependencies.metadataResolver, {
          ...dependencies.caching?.metadata,
          observer: cacheObserver,
        });
  const providers = dependencies.providers.map((provider) => {
    const protectedProvider =
      dependencies.providerExecutionPolicy === false
        ? provider
        : applyProviderExecutionPolicy(provider, dependencies.providerExecutionPolicy);
    return dependencies.caching === false
      ? protectedProvider
      : createCachedStreamProvider(protectedProvider, {
          ...dependencies.caching?.provider,
          observer: cacheObserver,
        });
  });
  return {
    async search(request, context) {
      const startedAt = clock();
      const metadata = await metadataResolver.resolve(request, context);
      const queries = generateSearchQueries(metadata, { includeSeasonPacks: true });
      const providerResults = await searchProviders(
        providers,
        queries,
        dependencies.configuration,
        context,
        dependencies.observer,
        clock,
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
      const streams = formatStreams(
        limited,
        dependencies.configuration,
        dependencies.websharePlaybackUrl,
        dependencies.torboxPlaybackUrl,
        request,
        ranked,
      );
      observeSearch(dependencies.observer, {
        type: 'search-complete',
        correlationId: context.correlationId,
        durationMs: Math.max(0, clock() - startedAt),
        rawResultCount: providerResults.length,
        matchedResultCount: matched.length,
        filteredResultCount: filtered.length,
        returnedResultCount: streams.length,
      });
      return streams;
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
  observer: SearchObserver | undefined,
  clock: () => number,
): Promise<readonly ProviderResult[]> {
  const enabled = providers.filter((provider) => configuration.providers[provider.name].enabled);
  const providerSettlements = await Promise.allSettled(
    enabled.map(async (provider) => {
      const startedAt = clock();
      const results: ProviderResult[] = [];
      let failureCount = 0;
      for (const query of queries) {
        try {
          results.push(...(await provider.search(query, context)));
        } catch (error) {
          context.signal.throwIfAborted();
          failureCount += 1;
          observeSearch(observer, {
            type: 'provider-error',
            provider: provider.name,
            category: classifyApplicationError(error, 'ProviderUnavailable').kind,
            correlationId: context.correlationId,
          });
        }
      }
      observeSearch(observer, {
        type: 'provider-complete',
        provider: provider.name,
        durationMs: Math.max(0, clock() - startedAt),
        rawResultCount: results.length,
        failureCount,
        correlationId: context.correlationId,
      });
      return results;
    }),
  );
  context.signal.throwIfAborted();
  return providerSettlements.flatMap((settlement) =>
    settlement.status === 'fulfilled' ? settlement.value : [],
  );
}
