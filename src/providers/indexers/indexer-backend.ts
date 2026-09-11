import type {
  IndexerDiscoveryResult,
  IndexerSearchResult,
  TorznabCapabilities,
  TorznabQuery,
} from './indexer-types.js';

export type IndexerBackendContext = { signal?: AbortSignal };

export type AcquiredTorrent =
  | { kind: 'file'; infoHash: string; magnetUri: string; torrentFile: Uint8Array }
  | { kind: 'magnet'; infoHash: string; magnetUri: string };

export type IndexerBackendErrorKind =
  | 'authentication-failed'
  | 'cancelled'
  | 'timeout'
  | 'rate-limited'
  | 'unavailable'
  | 'invalid-response';

export class IndexerBackendError extends Error {
  override readonly name = 'IndexerBackendError';
  readonly statusCode?: number;
  readonly retryAfterMs?: number;

  constructor(
    readonly kind: IndexerBackendErrorKind,
    message: string,
    options?: { statusCode?: number; retryAfterMs?: number; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    if (options?.statusCode !== undefined) this.statusCode = options.statusCode;
    if (options?.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
  }
}

export type IndexerBackend = {
  discover(context?: IndexerBackendContext): Promise<readonly IndexerDiscoveryResult[]>;
  capabilities(indexerId: string, context?: IndexerBackendContext): Promise<TorznabCapabilities>;
  search(
    indexer: Pick<IndexerDiscoveryResult, 'backendId' | 'name'>,
    query: TorznabQuery,
    mediaType: 'movie' | 'series',
    context?: IndexerBackendContext,
  ): Promise<readonly IndexerSearchResult[]>;
  acquire(
    indexerId: string,
    acquisitionReference: string,
    expectedInfoHash?: string,
    context?: IndexerBackendContext,
  ): Promise<AcquiredTorrent>;
};

export const isEligiblePublicTorrentIndexer = (indexer: IndexerDiscoveryResult): boolean =>
  indexer.enabled &&
  indexer.supportsSearch &&
  indexer.protocol === 'torrent' &&
  indexer.privacy === 'public';
