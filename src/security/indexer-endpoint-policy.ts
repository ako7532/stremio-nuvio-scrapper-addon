export type IndexerEndpointPolicy = {
  assertAllowed(endpoint: string): URL;
};

export const createIndexerEndpointPolicy = (
  allowedOrigins: readonly string[],
): IndexerEndpointPolicy => {
  const allowed = new Set(allowedOrigins.map(normalizeOrigin));
  return {
    assertAllowed(endpoint) {
      const url = normalizeEndpoint(endpoint);
      if (!allowed.has(url.origin)) {
        throw new TypeError('Indexer endpoint origin is not allowed by the server');
      }
      return url;
    },
  };
};

const normalizeOrigin = (value: string): string => {
  const url = normalizeEndpoint(value);
  if (url.pathname !== '/') {
    throw new TypeError('Allowed Indexers origins must not contain a path');
  }
  return url.origin;
};

const normalizeEndpoint = (value: string): URL => {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new TypeError('Indexer endpoint must use HTTP or HTTPS');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new TypeError('Indexer endpoint must not contain credentials, query, or fragment');
  }
  return url;
};
