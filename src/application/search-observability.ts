import type { ApplicationErrorKind } from './application-error.js';
import type { ProviderName } from '../domain/release.js';
import type { CacheEvent } from '../infrastructure/cache-observer.js';

export type SearchStage = 'precise' | 'season' | 'broad';
export type TorboxPlaybackStage =
  'list-torrents' | 'check-cache' | 'create-torrent' | 'refresh-torrent' | 'request-download-link';
export type TorboxPrecacheStage = 'discovery' | 'selection' | 'create-torrent';

export type SearchObservation =
  | {
      type: 'indexers-provider-summary';
      selectedIndexerCount: number;
      eligibleIndexerCount: number;
      queryCount: number;
      matchedResultCount: number;
      acquisitionAttemptCount: number;
      acquisitionFailureCount: number;
      returnedResultCount: number;
      correlationId: string;
    }
  | {
      type: 'torbox-precache-stage';
      stage: TorboxPrecacheStage;
      outcome: 'complete' | 'failed';
      durationMs: number;
      candidateCount?: number;
      season?: number;
      episode?: number;
      category?: string;
      statusCode?: number;
      errorCode?: string;
    }
  | {
      type: 'torbox-playback-stage';
      stage: TorboxPlaybackStage;
      outcome: 'complete' | 'failed';
      durationMs: number;
      category?: string;
      statusCode?: number;
    }
  | ({ type: 'cache' } & CacheEvent)
  | {
      type: 'search-start';
      mediaType: 'movie' | 'series';
      mediaId: string;
      season?: number;
      episode?: number;
      correlationId: string;
    }
  | {
      type: 'metadata-resolved';
      titles: readonly string[];
      year?: number;
      durationMs: number;
      correlationId: string;
    }
  | {
      type: 'search-error';
      phase: 'metadata';
      category: ApplicationErrorKind;
      durationMs: number;
      correlationId: string;
    }
  | {
      type: 'provider-error';
      provider: ProviderName;
      category: ApplicationErrorKind;
      correlationId: string;
    }
  | {
      type: 'provider-results-profile';
      byProvider: Readonly<Record<string, number>>;
      byResolution: Readonly<Record<string, number>>;
      bySource: Readonly<Record<string, number>>;
      unparsedCount: number;
      correlationId: string;
    }
  | {
      type: 'provider-stage-complete';
      provider: ProviderName;
      stage: SearchStage;
      queries: readonly string[];
      durationMs: number;
      rawResultCount: number;
      failureCount: number;
      correlationId: string;
    }
  | {
      type: 'provider-complete';
      provider: ProviderName;
      durationMs: number;
      rawResultCount: number;
      failureCount: number;
      correlationId: string;
    }
  | {
      type: 'matching-complete';
      acceptedCount: number;
      rejectedCount: number;
      rejectionReasons: Readonly<Record<string, number>>;
      correlationId: string;
    }
  | {
      type: 'filtering-complete';
      deduplicatedCount: number;
      acceptedCount: number;
      rejectionReasons: Readonly<Record<string, number>>;
      correlationId: string;
    }
  | {
      type: 'cache-enrichment-complete';
      cachedCount: number;
      uncachedCount: number;
      unknownCount: number;
      notApplicableCount: number;
      deferred?: boolean;
      durationMs: number;
      correlationId: string;
    }
  | {
      type: 'playback-filtering-complete';
      acceptedCount: number;
      rejectionReasons: Readonly<Record<string, number>>;
      correlationId: string;
    }
  | {
      type: 'search-complete';
      durationMs: number;
      rawResultCount: number;
      matchedResultCount: number;
      filteredResultCount: number;
      returnedResultCount: number;
      correlationId: string;
    };

export type SearchObserver = (event: SearchObservation) => void;

export function observeSearch(
  observer: SearchObserver | undefined,
  event: SearchObservation,
): void {
  try {
    observer?.(event);
  } catch {
    // Observabilita nesmie ovplyvniť výsledok požiadavky.
  }
}
