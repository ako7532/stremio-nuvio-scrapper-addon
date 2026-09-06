import type { ProviderName } from '../domain/release.js';

export type CacheEvent = {
  cache: 'metadata' | 'provider-search' | 'sktorrent-detail' | 'torbox-status';
  hitCount: number;
  missCount: number;
  provider?: ProviderName | 'torbox';
  correlationId?: string;
};

export type CacheObserver = (event: CacheEvent) => void;

export function observeCache(observer: CacheObserver | undefined, event: CacheEvent): void {
  try {
    observer?.(event);
  } catch {
    // Observabilita nesmie ovplyvniť výsledok požiadavky.
  }
}
