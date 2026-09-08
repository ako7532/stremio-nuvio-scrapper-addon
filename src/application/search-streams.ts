import { deduplicateResults } from '../aggregation/result-deduplicator.js';
import { getFilterRejectionReason } from '../aggregation/result-filters.js';
import { limitResults } from '../aggregation/result-limits.js';
import { rankResults } from '../aggregation/result-ranking.js';
import type { UserConfiguration } from '../domain/configuration.js';
import type { MediaMetadata, MediaRequest, SearchQuery } from '../domain/media.js';
import {
  isTorrentProviderResult,
  type ProviderResult,
  type RankedResult,
} from '../domain/release.js';
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
import { normalizeTitle } from '../metadata/title-normalizer.js';
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
import { observeSearch, type SearchObserver, type SearchStage } from './search-observability.js';

export type SearchStreamsContext = { signal: AbortSignal; correlationId: string };
export type SearchStreams = {
  search(request: MediaRequest, context: SearchStreamsContext): Promise<readonly StremioStream[]>;
  findNextEpisodeCandidates?(
    request: MediaRequest,
    count: number,
    context: SearchStreamsContext,
  ): Promise<readonly RankedResult[]>;
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
  deferCacheEnrichmentUntilPlayback?: boolean;
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
      observeSearch(dependencies.observer, {
        type: 'search-start',
        mediaType: request.type,
        mediaId: diagnosticText(request.id),
        ...(request.type === 'series' ? { season: request.season, episode: request.episode } : {}),
        correlationId: context.correlationId,
      });
      const metadataStartedAt = clock();
      let metadata: MediaMetadata;
      try {
        metadata = await metadataResolver.resolve(request, context);
      } catch (error) {
        context.signal.throwIfAborted();
        observeSearch(dependencies.observer, {
          type: 'search-error',
          phase: 'metadata',
          category: classifyApplicationError(error, 'ProviderUnavailable').kind,
          durationMs: Math.max(0, clock() - metadataStartedAt),
          correlationId: context.correlationId,
        });
        throw error;
      }
      observeSearch(dependencies.observer, {
        type: 'metadata-resolved',
        titles: metadataTitles(metadata),
        ...(metadata.year === undefined ? {} : { year: metadata.year }),
        durationMs: Math.max(0, clock() - metadataStartedAt),
        correlationId: context.correlationId,
      });
      const queries = generateSearchQueries(metadata, { includeSeasonPacks: true });
      const providerResults = await searchProviders(
        providers,
        metadata,
        queries,
        dependencies.configuration,
        context,
        dependencies.observer,
        clock,
      );
      observeSearch(dependencies.observer, {
        type: 'provider-results-profile',
        ...profileProviderResults(providerResults),
        correlationId: context.correlationId,
      });
      const matchingRejections: Record<string, number> = {};
      const matched = providerResults.flatMap((result) => {
        const decision =
          metadata.type === 'movie' ? matchMovie(metadata, result) : matchEpisode(metadata, result);
        if (decision.matched) return [{ result, matchScore: decision.score, rankValues: {} }];
        increment(matchingRejections, matchRejectionReason(decision.reasons));
        return [];
      });
      observeSearch(dependencies.observer, {
        type: 'matching-complete',
        acceptedCount: matched.length,
        rejectedCount: providerResults.length - matched.length,
        rejectionReasons: matchingRejections,
        correlationId: context.correlationId,
      });
      const deduplicated = deduplicateResults(matched);
      const filterRejections: Record<string, number> = {};
      const filterAccepted = deduplicated.filter(({ result }) => {
        const reason = getFilterRejectionReason(result, dependencies.configuration);
        if (reason === undefined) return true;
        increment(filterRejections, reason);
        return false;
      });
      observeSearch(dependencies.observer, {
        type: 'filtering-complete',
        deduplicatedCount: deduplicated.length,
        acceptedCount: filterAccepted.length,
        rejectionReasons: filterRejections,
        correlationId: context.correlationId,
      });
      const playbackRejections: Record<string, number> = {};
      const filtered = filterAccepted.filter(({ result }) => {
        const reason = playbackCandidateRejection(result, dependencies);
        if (reason === undefined) return true;
        increment(playbackRejections, reason);
        return false;
      });
      const cacheStartedAt = clock();
      const cacheDeferred =
        dependencies.cacheEnricher !== undefined &&
        dependencies.deferCacheEnrichmentUntilPlayback === true;
      const enriched =
        dependencies.cacheEnricher === undefined || dependencies.deferCacheEnrichmentUntilPlayback
          ? filtered
          : await dependencies.cacheEnricher(filtered, context);
      const cacheCounts = countCacheStatuses(enriched);
      observeSearch(dependencies.observer, {
        type: 'cache-enrichment-complete',
        ...cacheCounts,
        ...(cacheDeferred ? { deferred: true } : {}),
        durationMs: Math.max(0, clock() - cacheStartedAt),
        correlationId: context.correlationId,
      });
      const ranked = rankResults(enriched, dependencies.configuration);
      const available = ranked.filter(({ result }) => {
        const reason = playbackAvailabilityRejection(result, dependencies);
        if (reason === undefined) return true;
        increment(playbackRejections, reason);
        return false;
      });
      observeSearch(dependencies.observer, {
        type: 'playback-filtering-complete',
        acceptedCount: available.length,
        rejectionReasons: playbackRejections,
        correlationId: context.correlationId,
      });
      const limited = limitResults(available, dependencies.configuration.limits);
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
    async findNextEpisodeCandidates(request, count, context) {
      if (request.type !== 'series' || count <= 0) return [];
      const metadata = await metadataResolver.resolve(request, context);
      if (metadata.type !== 'series') return [];
      const episodes = Array.from(
        { length: Math.min(10, Math.floor(count)) },
        (_, index) => request.episode + index + 1,
      );
      const candidates = await mapWithConcurrency(episodes, 2, async (episode) =>
        findEpisodePrecacheCandidate(
          { ...metadata, episode },
          providers,
          dependencies,
          context,
          clock,
        ),
      );
      return candidates.filter((candidate): candidate is RankedResult => candidate !== undefined);
    },
  };
}

async function findEpisodePrecacheCandidate(
  metadata: Extract<MediaMetadata, { type: 'series' }>,
  providers: readonly StreamProvider[],
  dependencies: SearchStreamsDependencies,
  context: SearchStreamsContext,
  clock: () => number,
): Promise<RankedResult | undefined> {
  const results = await searchProviders(
    providers,
    metadata,
    generateSearchQueries(metadata, { includeSeasonPacks: true }),
    dependencies.configuration,
    context,
    undefined,
    clock,
  );
  const matched = results.flatMap((result) => {
    if (!isTorrentProviderResult(result)) return [];
    const decision = matchEpisode(metadata, result);
    if (!decision.matched || getFilterRejectionReason(result, dependencies.configuration))
      return [];
    return [{ result, matchScore: decision.score, rankValues: {} }];
  });
  const deduplicated = deduplicateResults(matched);
  const enriched =
    dependencies.cacheEnricher === undefined
      ? deduplicated
      : await dependencies.cacheEnricher(deduplicated, context);
  const ranked = rankResults(enriched, dependencies.configuration);
  const eligible = ranked.filter(
    ({ result }) => isTorrentProviderResult(result) && result.cacheStatus !== 'unknown',
  );
  for (const kind of ['single-episode', 'multi-episode', 'season-pack'] as const) {
    const candidate = eligible.find(({ result }) => matchEpisode(metadata, result).kind === kind);
    if (candidate !== undefined) return candidate;
  }
  return undefined;
}

async function mapWithConcurrency<Input, Output>(
  values: readonly Input[],
  concurrency: number,
  mapper: (value: Input) => Promise<Output>,
): Promise<readonly Output[]> {
  const results = new Array<Output>(values.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      const value = values[index];
      if (value !== undefined) results[index] = await mapper(value);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}

function playbackCandidateRejection(
  result: ProviderResult,
  dependencies: SearchStreamsDependencies,
): string | undefined {
  if (result.provider === 'webshare') {
    return dependencies.websharePlaybackUrl === undefined
      ? 'webshare playback unavailable'
      : undefined;
  }
  if (torrentUsesTorbox(result, dependencies.configuration)) {
    if (dependencies.torboxPlaybackUrl === undefined) return 'torbox playback unavailable';
    if (result.magnetUri === undefined) return 'torrent magnet missing';
    return undefined;
  }
  return result.mediaType === 'series' && result.filename === undefined
    ? 'series filename missing'
    : undefined;
}

function playbackAvailabilityRejection(
  result: ProviderResult,
  dependencies: SearchStreamsDependencies,
): string | undefined {
  if (!isTorrentProviderResult(result) || !torrentUsesTorbox(result, dependencies.configuration)) {
    return undefined;
  }
  if (dependencies.deferCacheEnrichmentUntilPlayback === true) return undefined;
  if (result.cacheStatus === 'cached') return undefined;
  if (result.cacheStatus === 'uncached' && dependencies.configuration.torbox.showUncached) {
    return undefined;
  }
  return result.cacheStatus === 'uncached' ? 'uncached hidden' : 'cache status unknown';
}

async function searchProviders(
  providers: readonly StreamProvider[],
  metadata: MediaMetadata,
  queries: readonly SearchQuery[],
  configuration: UserConfiguration,
  context: SearchStreamsContext,
  observer: SearchObserver | undefined,
  clock: () => number,
): Promise<readonly ProviderResult[]> {
  const enabled = providers.filter(
    (provider) => configuration.providers[provider.name]?.enabled === true,
  );
  const primaryQueries = selectDistinctTitleQueries(
    queries.filter((query) => query.fallback !== true),
  );
  const fallbackQueries = selectDistinctTitleQueries(
    queries.filter((query) => query.fallback === true && query.broad !== true),
  );
  const broadQueries = selectDistinctTitleQueries(queries.filter((query) => query.broad === true));
  const providerSettlements = await Promise.allSettled(
    enabled.map(async (provider) => {
      const startedAt = clock();
      const results: ProviderResult[] = [];
      let failureCount = 0;
      if (provider.searchMetadata !== undefined) {
        try {
          results.push(...(await provider.searchMetadata(metadata, context)));
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
        observeSearch(observer, {
          type: 'provider-complete',
          provider: provider.name,
          durationMs: Math.max(0, clock() - startedAt),
          rawResultCount: results.length,
          failureCount,
          correlationId: context.correlationId,
        });
        return results;
      }
      const queryGroups: readonly (readonly [SearchStage, readonly SearchQuery[]])[] = [
        ['precise', primaryQueries],
        ['season', fallbackQueries],
        ['broad', broadQueries],
      ];
      for (const [stage, queryGroup] of queryGroups) {
        if (results.length > 0) break;
        if (queryGroup.length === 0) continue;
        const stageStartedAt = clock();
        let stageResultCount = 0;
        let stageFailureCount = 0;
        const settlements = await Promise.allSettled(
          queryGroup.map((query) => provider.search(query, context)),
        );
        for (const settlement of settlements) {
          if (settlement.status === 'fulfilled') {
            results.push(...settlement.value);
            stageResultCount += settlement.value.length;
          } else {
            context.signal.throwIfAborted();
            failureCount += 1;
            stageFailureCount += 1;
            observeSearch(observer, {
              type: 'provider-error',
              provider: provider.name,
              category: classifyApplicationError(settlement.reason, 'ProviderUnavailable').kind,
              correlationId: context.correlationId,
            });
          }
        }
        observeSearch(observer, {
          type: 'provider-stage-complete',
          provider: provider.name,
          stage,
          queries: queryGroup.map((query) => diagnosticText(query.value)),
          durationMs: Math.max(0, clock() - stageStartedAt),
          rawResultCount: stageResultCount,
          failureCount: stageFailureCount,
          correlationId: context.correlationId,
        });
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

const MAXIMUM_QUERY_TITLES = 2;

function selectDistinctTitleQueries(queries: readonly SearchQuery[]): readonly SearchQuery[] {
  const selected: SearchQuery[] = [];
  const titles = new Set<string>();
  for (const query of queries) {
    const title = normalizeTitle(query.title);
    if (titles.has(title)) continue;
    titles.add(title);
    selected.push(query);
    if (selected.length === MAXIMUM_QUERY_TITLES) break;
  }
  return selected;
}

function metadataTitles(metadata: MediaMetadata): readonly string[] {
  return [
    metadata.slovakTitle,
    metadata.czechTitle,
    metadata.englishTitle,
    metadata.originalTitle,
    ...metadata.alternativeTitles,
  ]
    .filter(
      (title, index, titles): title is string =>
        title !== undefined && titles.indexOf(title) === index,
    )
    .slice(0, 8)
    .map(diagnosticText);
}

const diagnosticText = (value: string): string => value.slice(0, 200);

function matchRejectionReason(reasons: readonly string[]): string {
  return (
    reasons.find(
      (reason) =>
        reason.includes('mismatch') || reason.includes('missing') || reason.startsWith('non-'),
    ) ?? 'score below threshold'
  );
}

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function countCacheStatuses(results: readonly RankedResult[]): {
  cachedCount: number;
  uncachedCount: number;
  unknownCount: number;
  notApplicableCount: number;
} {
  let cachedCount = 0;
  let uncachedCount = 0;
  let unknownCount = 0;
  let notApplicableCount = 0;
  for (const { result } of results) {
    if (!isTorrentProviderResult(result)) notApplicableCount += 1;
    else if (result.cacheStatus === 'cached') cachedCount += 1;
    else if (result.cacheStatus === 'uncached') uncachedCount += 1;
    else unknownCount += 1;
  }
  return { cachedCount, uncachedCount, unknownCount, notApplicableCount };
}

const torrentUsesTorbox = (result: ProviderResult, configuration: UserConfiguration): boolean =>
  isTorrentProviderResult(result) &&
  (result.provider === 'indexers' ||
    configuration.providers.sktorrent.playbackMode === 'torbox-only');

function profileProviderResults(results: readonly ProviderResult[]): {
  byProvider: Readonly<Record<string, number>>;
  byResolution: Readonly<Record<string, number>>;
  bySource: Readonly<Record<string, number>>;
  unparsedCount: number;
} {
  const byProvider: Record<string, number> = {};
  const byResolution: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  let unparsedCount = 0;
  for (const result of results) {
    increment(byProvider, result.provider);
    if (result.parsed === undefined) {
      unparsedCount += 1;
      continue;
    }
    increment(byResolution, result.parsed.resolution);
    increment(bySource, result.parsed.source);
  }
  return { byProvider, byResolution, bySource, unparsedCount };
}
