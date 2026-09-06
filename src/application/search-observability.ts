import type { ApplicationErrorKind } from './application-error.js';
import type { ProviderName } from '../domain/release.js';
import type { CacheEvent } from '../infrastructure/cache-observer.js';

export type SearchObservation =
  | ({ type: 'cache' } & CacheEvent)
  | {
      type: 'provider-error';
      provider: ProviderName;
      category: ApplicationErrorKind;
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
