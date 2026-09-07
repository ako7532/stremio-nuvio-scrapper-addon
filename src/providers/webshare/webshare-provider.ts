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
    const queryValues = webshareQueryValues(query);
    const settlements = await Promise.allSettled(
      queryValues.map((value) => source.search(value, context.signal)),
    );
    context.signal.throwIfAborted();
    const files = deduplicateFiles(
      settlements.flatMap((settlement) =>
        settlement.status === 'fulfilled' ? settlement.value : [],
      ),
    );
    if (files.length > 0) return files.map((file) => normalizeFile(file, query));
    const failure = settlements.find((settlement) => settlement.status === 'rejected');
    if (failure !== undefined) throw failure.reason;
    return [];
  },
});

const webshareQueryValues = (query: SearchQuery): readonly string[] => {
  if (query.type !== 'movie') return [query.value];
  const compact = /(?:^|\s)([\p{L}\p{M}'’-]{3,})\s+((?:19|20)\d{2})$/u.exec(query.title.trim());
  if (compact?.[1] === undefined || compact[2] === undefined) return [query.value];
  return [query.value, `${compact[1]}${compact[2]}`];
};

const deduplicateFiles = (files: readonly WebshareFile[]): readonly WebshareFile[] => {
  const seen = new Set<string>();
  return files.filter((file) => {
    if (seen.has(file.id)) return false;
    seen.add(file.id);
    return true;
  });
};

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
