import type { SearchQuery } from '../domain/media.js';
import type { ProviderName, ProviderResult, ProviderSource } from '../domain/release.js';

export type ProviderCapabilities = {
  search: true;
  source: ProviderSource;
  requiresAuthentication: boolean;
  supportsDirectStreaming: boolean;
  supportsCacheLookup: boolean;
};

export type ProviderSearchContext = {
  signal: AbortSignal;
  correlationId: string;
};

export type StreamProvider = {
  readonly name: ProviderName;
  readonly capabilities: ProviderCapabilities;
  search(query: SearchQuery, context: ProviderSearchContext): Promise<readonly ProviderResult[]>;
};
