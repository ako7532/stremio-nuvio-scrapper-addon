import type { SearchQuery } from '../../domain/media.js';
import type { TorrentProviderResult } from '../../domain/release.js';
import { releaseCoversSeason } from '../../matching/episode-matcher.js';
import { parseRelease } from '../../release/release-parser.js';
import type { ProviderCapabilities, ProviderSearchContext, StreamProvider } from '../provider.js';
import {
  createCachedSktorrentSource,
  type SktorrentSourceCacheOptions,
} from './sktorrent-cache.js';
import type { SktorrentSource } from './sktorrent-source.js';
import { parseSktorrentTorrent } from './sktorrent-torrent-parser.js';
import type { SktorrentListingResult } from './sktorrent-types.js';
import type { TorrentFileStore } from '../../application/torrent-file-store.js';

export type SktorrentProviderOptions = {
  maximumDetails?: number;
  detailConcurrency?: number;
  detailCache?: false | SktorrentSourceCacheOptions;
  torrentFiles?: { store: TorrentFileStore; namespace: string };
};

const capabilities: ProviderCapabilities = {
  search: true,
  source: 'torrent',
  requiresAuthentication: true,
  supportsDirectStreaming: false,
  supportsCacheLookup: false,
};

export const createSktorrentProvider = (
  source: SktorrentSource,
  options: SktorrentProviderOptions = {},
): StreamProvider => {
  const maximumDetails = positiveInteger(options.maximumDetails ?? 10, 'maximum details');
  const detailConcurrency = positiveInteger(options.detailConcurrency ?? 5, 'detail concurrency');
  const providerSource =
    options.detailCache === false
      ? source
      : createCachedSktorrentSource(source, options.detailCache);

  return {
    name: 'sktorrent',
    capabilities,
    async search(query, context) {
      const [listingResults] = await Promise.all([
        providerSource.search(query.value, context.signal),
        providerSource.validateAuthentication?.(context.signal) ?? Promise.resolve(),
      ]);
      const relevantListings =
        query.type === 'series' && query.broad === true
          ? preferMatchingSeasonListings(listingResults, query.season)
          : listingResults;
      const listings = selectDiverseListings(relevantListings, maximumDetails);
      const settlements = await mapWithConcurrency(listings, detailConcurrency, async (listing) => {
        try {
          return {
            status: 'fulfilled' as const,
            value: await normalizeListing(
              providerSource,
              listing,
              query,
              context,
              options.torrentFiles,
            ),
          };
        } catch (reason) {
          context.signal.throwIfAborted();
          return { status: 'rejected' as const, reason };
        }
      });
      const results = settlements.flatMap((settlement) =>
        settlement.status === 'fulfilled' ? [settlement.value] : [],
      );
      if (results.length > 0 || settlements.length === 0) return results;
      const failure = settlements.find((settlement) => settlement.status === 'rejected');
      if (failure === undefined) return [];
      throw failure.reason;
    },
  };
};

const preferMatchingSeasonListings = (
  listings: readonly SktorrentListingResult[],
  season: number,
): readonly SktorrentListingResult[] => {
  const matching = listings.filter((listing) => releaseCoversSeason(listing.title, season));
  return matching.length > 0 ? matching : listings;
};

const selectDiverseListings = (
  listings: readonly SktorrentListingResult[],
  maximum: number,
): readonly SktorrentListingResult[] => {
  const groups = new Map<string, SktorrentListingResult[]>();
  for (const listing of listings) {
    const resolution = parseRelease(listing.title).resolution;
    const group = groups.get(resolution) ?? [];
    group.push(listing);
    groups.set(resolution, group);
  }
  const selected: SktorrentListingResult[] = [];
  for (let offset = 0; selected.length < maximum; offset += 1) {
    let found = false;
    for (const group of groups.values()) {
      const listing = group[offset];
      if (listing === undefined) continue;
      selected.push(listing);
      found = true;
      if (selected.length === maximum) break;
    }
    if (!found) break;
  }
  return selected;
};

const normalizeListing = async (
  source: SktorrentSource,
  listing: SktorrentListingResult,
  query: SearchQuery,
  context: ProviderSearchContext,
  torrentFiles: SktorrentProviderOptions['torrentFiles'],
): Promise<TorrentProviderResult> => {
  const detail = await source.getDetail(listing, context.signal);
  const torrentFile = await source.downloadTorrent(detail, context.signal);
  const torrent = parseSktorrentTorrent(torrentFile, detail.id);
  context.signal.throwIfAborted();
  torrentFiles?.store.put(torrentFiles.namespace, torrent.infoHash, torrentFile);
  const parsed = parseRelease(
    detail.title,
    ...detail.files.map((file) => file.name),
    detail.mediaInfo,
    detail.declaredLanguage === undefined ? undefined : `audio ${detail.declaredLanguage}`,
    detail.declaredSubtitles === undefined ? undefined : `subtitles ${detail.declaredSubtitles}`,
  );
  const filename = detail.files.length === 1 ? detail.files[0]?.name : undefined;

  return {
    provider: 'sktorrent',
    source: 'torrent',
    id: detail.id,
    title: detail.title,
    releaseName: detail.title,
    mediaType: query.type,
    ...(query.type === 'series'
      ? {
          season: query.season,
          ...(query.episode === undefined ? {} : { episode: query.episode }),
        }
      : {}),
    ...(filename === undefined ? {} : { filename }),
    sizeBytes: detail.sizeBytes,
    seeders: detail.seeders,
    providerUrl: detail.providerUrl,
    parsed,
    parsedConfidence: parsed.confidence,
    infoHash: torrent.infoHash,
    magnetUri: torrent.magnetUri,
    cacheStatus: 'unknown',
  };
};

const mapWithConcurrency = async <Input, Output>(
  values: readonly Input[],
  concurrency: number,
  mapper: (value: Input) => Promise<Output>,
): Promise<readonly Output[]> => {
  const results = new Array<Output>(values.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      const value = values[index];
      if (value !== undefined) {
        results[index] = await mapper(value);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
};

const positiveInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`SKTorrent provider ${name} must be a positive integer`);
  }
  return value;
};
