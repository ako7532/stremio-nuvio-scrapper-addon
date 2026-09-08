import type { TorrentFileStore } from '../../application/torrent-file-store.js';
import { observeSearch, type SearchObserver } from '../../application/search-observability.js';
import type { MediaMetadata, SearchQuery } from '../../domain/media.js';
import type { TorrentProviderResult } from '../../domain/release.js';
import { createBoundedTtlCache } from '../../infrastructure/bounded-ttl-cache.js';
import { matchEpisode } from '../../matching/episode-matcher.js';
import { matchMovie } from '../../matching/movie-matcher.js';
import { parseRelease } from '../../release/release-parser.js';
import type { ProviderCapabilities, ProviderSearchContext, StreamProvider } from '../provider.js';
import {
  IndexerBackendError,
  isEligiblePublicTorrentIndexer,
  type IndexerBackend,
} from './indexer-backend.js';
import { planIndexerQueries } from './indexer-query-planner.js';
import type {
  IndexerDiscoveryResult,
  IndexerSearchResult,
  TorznabCapabilities,
} from './indexer-types.js';
import { normalizeBtih } from './torrent-identity.js';

export type IndexersProviderOptions = {
  selectedIndexerIds: readonly string[];
  indexerConcurrency?: number;
  acquisitionConcurrency?: number;
  maximumAcquisitions?: number;
  metadataCacheTtlMs?: number;
  clock?: () => number;
  torrentFiles?: { store: TorrentFileStore; namespace: string };
  observer?: SearchObserver;
};

const DEFAULT_INDEXER_CONCURRENCY = 3;
const DEFAULT_ACQUISITION_CONCURRENCY = 3;
const DEFAULT_MAXIMUM_ACQUISITIONS = 10;
const DEFAULT_METADATA_CACHE_TTL_MS = 5 * 60_000;
const MAXIMUM_SELECTED_INDEXERS = 20;

const capabilities: ProviderCapabilities = {
  search: true,
  source: 'torrent',
  requiresAuthentication: true,
  supportsDirectStreaming: false,
  supportsCacheLookup: false,
};

export const createIndexersProvider = (
  backend: IndexerBackend,
  options: IndexersProviderOptions,
): StreamProvider => {
  const selectedIndexerIds = selectedIds(options.selectedIndexerIds);
  const indexerConcurrency = positiveInteger(
    options.indexerConcurrency ?? DEFAULT_INDEXER_CONCURRENCY,
    'indexer concurrency',
  );
  const acquisitionConcurrency = positiveInteger(
    options.acquisitionConcurrency ?? DEFAULT_ACQUISITION_CONCURRENCY,
    'acquisition concurrency',
  );
  const maximumAcquisitions = positiveInteger(
    options.maximumAcquisitions ?? DEFAULT_MAXIMUM_ACQUISITIONS,
    'maximum acquisitions',
  );
  const metadataCacheTtlMs = positiveInteger(
    options.metadataCacheTtlMs ?? DEFAULT_METADATA_CACHE_TTL_MS,
    'metadata cache TTL',
  );
  const discoveryCache = createBoundedTtlCache<'discovery', readonly IndexerDiscoveryResult[]>({
    ttlMs: metadataCacheTtlMs,
    maximumEntries: 1,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  const capabilitiesCache = createBoundedTtlCache<string, TorznabCapabilities>({
    ttlMs: metadataCacheTtlMs,
    maximumEntries: MAXIMUM_SELECTED_INDEXERS,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });

  const searchMetadata = async (
    metadata: MediaMetadata,
    context: ProviderSearchContext,
  ): Promise<readonly TorrentProviderResult[]> => {
    const counters = { queryCount: 0 };
    const discovered = await cachedDiscovery(backend, discoveryCache, context);
    const byId = new Map(discovered.map((indexer) => [indexer.backendId, indexer]));
    const eligible = selectedIndexerIds.flatMap((id) => {
      const indexer = byId.get(id);
      return indexer !== undefined && isEligiblePublicTorrentIndexer(indexer) ? [indexer] : [];
    });
    if (eligible.length === 0) {
      observeSummary(options.observer, context, selectedIndexerIds.length, 0, counters, 0, [], []);
      return [];
    }

    const indexerSettlements = await mapSettledWithConcurrency(
      eligible,
      indexerConcurrency,
      async (indexer) =>
        searchOneIndexer(backend, capabilitiesCache, indexer, metadata, context, counters),
    );
    context.signal.throwIfAborted();
    const searched = indexerSettlements.flatMap((settlement) =>
      settlement.status === 'fulfilled' ? settlement.value : [],
    );
    const successfulIndexers = indexerSettlements.filter(
      (settlement) => settlement.status === 'fulfilled',
    ).length;
    if (successfulIndexers === 0) {
      observeSummary(
        options.observer,
        context,
        selectedIndexerIds.length,
        eligible.length,
        counters,
        0,
        [],
        [],
      );
      throw preferredFailure(indexerSettlements);
    }

    const relevant = deduplicateRawResults(searched).filter((result) =>
      preliminaryMatch(metadata, result),
    );
    const ready = relevant
      .filter(
        (result): result is IndexerSearchResult & { infoHash: string } =>
          result.infoHash !== undefined,
      )
      .map(normalizeResult);
    const pending = relevant
      .filter(
        (result): result is IndexerSearchResult & { acquisitionReference: string } =>
          result.infoHash === undefined && result.acquisitionReference !== undefined,
      )
      .slice(0, maximumAcquisitions);
    const acquisitionSettlements = await mapSettledWithConcurrency(
      pending,
      acquisitionConcurrency,
      async (result) => {
        const acquired = await backend.acquire(
          result.indexerId,
          result.acquisitionReference,
          undefined,
          { signal: context.signal },
        );
        context.signal.throwIfAborted();
        if (acquired.kind === 'file') {
          options.torrentFiles?.store.put(
            options.torrentFiles.namespace,
            acquired.infoHash,
            acquired.torrentFile,
          );
        }
        return normalizeResult({
          ...result,
          infoHash: acquired.infoHash,
          magnetUri: acquired.magnetUri,
        });
      },
    );
    const acquired = acquisitionSettlements.flatMap((settlement) =>
      settlement.status === 'fulfilled' ? [settlement.value] : [],
    );
    if (
      ready.length === 0 &&
      pending.length > 0 &&
      acquired.length === 0 &&
      acquisitionSettlements.every((settlement) => settlement.status === 'rejected')
    ) {
      observeSummary(
        options.observer,
        context,
        selectedIndexerIds.length,
        eligible.length,
        counters,
        relevant.length,
        acquisitionSettlements,
        [],
      );
      throw preferredFailure(acquisitionSettlements);
    }
    const normalized = deduplicateNormalized([...ready, ...acquired]);
    observeSummary(
      options.observer,
      context,
      selectedIndexerIds.length,
      eligible.length,
      counters,
      relevant.length,
      acquisitionSettlements,
      normalized,
    );
    return normalized;
  };

  return {
    name: 'indexers',
    capabilities,
    search(query, context) {
      const metadata = metadataFromQuery(query);
      return metadata === undefined ? Promise.resolve([]) : searchMetadata(metadata, context);
    },
    searchMetadata,
  };
};

const cachedDiscovery = async (
  backend: IndexerBackend,
  cache: ReturnType<typeof createBoundedTtlCache<'discovery', readonly IndexerDiscoveryResult[]>>,
  context: ProviderSearchContext,
): Promise<readonly IndexerDiscoveryResult[]> => {
  const cached = cache.get('discovery');
  if (cached.hit) return cached.value;
  const discovered = await backend.discover({ signal: context.signal });
  context.signal.throwIfAborted();
  cache.set('discovery', discovered);
  return discovered;
};

const cachedCapabilities = async (
  backend: IndexerBackend,
  cache: ReturnType<typeof createBoundedTtlCache<string, TorznabCapabilities>>,
  indexerId: string,
  context: ProviderSearchContext,
): Promise<TorznabCapabilities> => {
  const cached = cache.get(indexerId);
  if (cached.hit) return cached.value;
  const value = await backend.capabilities(indexerId, { signal: context.signal });
  context.signal.throwIfAborted();
  cache.set(indexerId, value);
  return value;
};

const searchOneIndexer = async (
  backend: IndexerBackend,
  cache: ReturnType<typeof createBoundedTtlCache<string, TorznabCapabilities>>,
  indexer: IndexerDiscoveryResult,
  metadata: MediaMetadata,
  context: ProviderSearchContext,
  counters: { queryCount: number },
): Promise<readonly IndexerSearchResult[]> => {
  const indexerCapabilities = await cachedCapabilities(backend, cache, indexer.backendId, context);
  const queries = planIndexerQueries(metadata, indexerCapabilities);
  const results: IndexerSearchResult[] = [];
  const failures: unknown[] = [];
  for (const query of queries) {
    try {
      counters.queryCount += 1;
      results.push(
        ...(await backend.search(indexer, query, metadata.type, { signal: context.signal })),
      );
    } catch (error) {
      context.signal.throwIfAborted();
      failures.push(error);
      if (
        error instanceof IndexerBackendError &&
        (error.kind === 'authentication-failed' || error.kind === 'rate-limited')
      ) {
        throw error;
      }
    }
  }
  if (queries.length > 0 && failures.length === queries.length) throw preferredError(failures);
  return results;
};

const observeSummary = (
  observer: SearchObserver | undefined,
  context: ProviderSearchContext,
  selectedIndexerCount: number,
  eligibleIndexerCount: number,
  counters: { queryCount: number },
  matchedResultCount: number,
  acquisitions: readonly Settled<TorrentProviderResult>[],
  returned: readonly TorrentProviderResult[],
): void => {
  observeSearch(observer, {
    type: 'indexers-provider-summary',
    selectedIndexerCount,
    eligibleIndexerCount,
    queryCount: counters.queryCount,
    matchedResultCount,
    acquisitionAttemptCount: acquisitions.length,
    acquisitionFailureCount: acquisitions.filter(({ status }) => status === 'rejected').length,
    returnedResultCount: returned.length,
    correlationId: context.correlationId,
  });
};

const preliminaryMatch = (metadata: MediaMetadata, result: IndexerSearchResult): boolean => {
  const candidate = {
    title: result.releaseName,
    releaseName: result.releaseName,
    mediaType: result.mediaType,
  };
  return metadata.type === 'movie'
    ? matchMovie(metadata, candidate).matched
    : matchEpisode(metadata, candidate).matched;
};

const normalizeResult = (
  result: IndexerSearchResult & { infoHash: string },
): TorrentProviderResult => {
  const infoHash = normalizeBtih(result.infoHash);
  const parsed = parseRelease(result.releaseName);
  return {
    provider: 'indexers',
    source: 'torrent',
    id: `${boundedId(result.indexerId)}:${infoHash}`,
    title: result.releaseName,
    releaseName: result.releaseName,
    mediaType: result.mediaType,
    ...(result.sizeBytes === undefined ? {} : { sizeBytes: result.sizeBytes }),
    ...(result.seeders === undefined ? {} : { seeders: result.seeders }),
    providerUrl: `https://indexers.invalid/${encodeURIComponent(boundedId(result.indexerId))}`,
    parsed,
    parsedConfidence: parsed.confidence,
    infoHash,
    magnetUri: `magnet:?xt=urn:btih:${infoHash}`,
    cacheStatus: 'unknown',
  };
};

const deduplicateRawResults = (
  results: readonly IndexerSearchResult[],
): readonly IndexerSearchResult[] => {
  const unique = new Map<string, IndexerSearchResult>();
  for (const result of results) {
    const key = [
      result.indexerId,
      result.infoHash,
      result.acquisitionReference,
      result.releaseGuid,
      result.releaseName,
    ]
      .filter((value): value is string => value !== undefined)
      .join('\u0000');
    if (!unique.has(key)) unique.set(key, result);
  }
  return [...unique.values()];
};

const deduplicateNormalized = (
  results: readonly TorrentProviderResult[],
): readonly TorrentProviderResult[] => {
  const unique = new Map<string, TorrentProviderResult>();
  for (const result of results) {
    const existing = unique.get(result.infoHash);
    if (existing === undefined || (result.seeders ?? -1) > (existing.seeders ?? -1)) {
      unique.set(result.infoHash, result);
    }
  }
  return [...unique.values()];
};

const selectedIds = (values: readonly string[]): readonly string[] => {
  if (values.length > MAXIMUM_SELECTED_INDEXERS) {
    throw new RangeError('Too many selected indexers');
  }
  const selected = new Set<string>();
  for (const value of values) {
    const normalized = boundedId(value);
    if (normalized !== value) throw new TypeError('Selected indexer ID is invalid');
    selected.add(normalized);
  }
  return [...selected];
};

const boundedId = (value: string): string => {
  if (!/^[a-z\d][a-z\d._-]{0,99}$/iu.test(value)) {
    throw new TypeError('Indexer ID is invalid');
  }
  return value;
};

const metadataFromQuery = (query: SearchQuery): MediaMetadata | undefined => {
  if (query.type === 'movie') {
    return {
      type: 'movie',
      id: 'internal:indexers-query',
      originalTitle: query.title,
      alternativeTitles: [],
      ...(query.year === undefined ? {} : { year: query.year }),
    };
  }
  if (query.episode === undefined) return undefined;
  return {
    type: 'series',
    id: 'internal:indexers-query',
    originalTitle: query.title,
    alternativeTitles: [],
    season: query.season,
    episode: query.episode,
    ...(query.year === undefined ? {} : { year: query.year }),
  };
};

type Settled<Value> = PromiseSettledResult<Value>;

const mapSettledWithConcurrency = async <Input, Output>(
  values: readonly Input[],
  concurrency: number,
  mapper: (value: Input) => Promise<Output>,
): Promise<readonly Settled<Output>[]> => {
  const settlements = new Array<Settled<Output>>(values.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      const value = values[index];
      if (value === undefined) continue;
      try {
        settlements[index] = { status: 'fulfilled', value: await mapper(value) };
      } catch (reason) {
        settlements[index] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return settlements;
};

const preferredFailure = <Value>(settlements: readonly Settled<Value>[]): unknown => {
  const errors: unknown[] = [];
  for (const settlement of settlements) {
    if (settlement.status === 'rejected') errors.push(settlement.reason as unknown);
  }
  return preferredError(errors);
};

const preferredError = (errors: readonly unknown[]): unknown =>
  errors.find(
    (error) => error instanceof IndexerBackendError && error.kind === 'authentication-failed',
  ) ??
  errors.find((error) => error instanceof IndexerBackendError && error.kind === 'rate-limited') ??
  errors[0] ??
  new IndexerBackendError('unavailable', 'All selected indexers failed');

const positiveInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`Indexers provider ${name} must be a positive integer`);
  }
  return value;
};
