import type { SearchQuery } from '../../domain/media.js';
import type { TorrentProviderResult } from '../../domain/release.js';
import { parseRelease } from '../../release/release-parser.js';
import type { ProviderCapabilities, ProviderSearchContext, StreamProvider } from '../provider.js';
import {
  createCachedSktorrentSource,
  type SktorrentSourceCacheOptions,
} from './sktorrent-cache.js';
import type { SktorrentSource } from './sktorrent-source.js';
import { parseSktorrentTorrent } from './sktorrent-torrent-parser.js';
import type { SktorrentListingResult } from './sktorrent-types.js';

export type SktorrentProviderOptions = {
  maximumDetails?: number;
  detailConcurrency?: number;
  detailCache?: false | SktorrentSourceCacheOptions;
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
  const maximumDetails = positiveInteger(options.maximumDetails ?? 12, 'maximum details');
  const detailConcurrency = positiveInteger(options.detailConcurrency ?? 3, 'detail concurrency');
  const providerSource =
    options.detailCache === false
      ? source
      : createCachedSktorrentSource(source, options.detailCache);

  return {
    name: 'sktorrent',
    capabilities,
    async search(query, context) {
      const listings = (await providerSource.search(query.value, context.signal)).slice(
        0,
        maximumDetails,
      );
      return mapWithConcurrency(listings, detailConcurrency, (listing) =>
        normalizeListing(providerSource, listing, query, context),
      );
    },
  };
};

const normalizeListing = async (
  source: SktorrentSource,
  listing: SktorrentListingResult,
  query: SearchQuery,
  context: ProviderSearchContext,
): Promise<TorrentProviderResult> => {
  const detail = await source.getDetail(listing, context.signal);
  const torrent = parseSktorrentTorrent(
    await source.downloadTorrent(detail, context.signal),
    detail.id,
  );
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
