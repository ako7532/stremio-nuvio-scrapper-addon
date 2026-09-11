export type IndexerBackendType = 'prowlarr' | 'jackett';

export type ServerIndexerConfiguration = {
  backend: IndexerBackendType;
  endpoint: string;
  apiKey: string;
  selectedIndexerIds: readonly string[];
};
