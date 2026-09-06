import type { SearchQuery } from '../../domain/media.js';
import type { FileProviderResult } from '../../domain/release.js';
import { parseRelease } from '../../release/release-parser.js';
import type { ProviderCapabilities, StreamProvider } from '../provider.js';
import type { WebshareSource } from './webshare-source.js';
import type { WebshareFile } from './webshare-types.js';

const capabilities: ProviderCapabilities = {
  search: true,
  source: 'file-hosting',
  requiresAuthentication: true,
  supportsDirectStreaming: true,
  supportsCacheLookup: false,
};

export const createWebshareProvider = (source: WebshareSource): StreamProvider => ({
  name: 'webshare',
  capabilities,
  async search(query, context) {
    return (await source.search(query.value, context.signal)).map((file) =>
      normalizeFile(file, query),
    );
  },
});

const normalizeFile = (file: WebshareFile, query: SearchQuery): FileProviderResult => {
  const parsed = parseRelease(file.name);
  return {
    provider: 'webshare',
    source: 'file-hosting',
    id: file.id,
    fileId: file.id,
    title: file.name,
    releaseName: file.name,
    mediaType: query.type,
    filename: file.name,
    sizeBytes: file.sizeBytes,
    providerUrl: file.providerUrl,
    parsed,
    parsedConfidence: parsed.confidence,
    available: file.available,
    streamable: file.streamable,
  };
};
