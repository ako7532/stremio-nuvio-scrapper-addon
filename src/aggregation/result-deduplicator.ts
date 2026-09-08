import { isTorrentProviderResult, type RankedResult } from '../domain/release.js';

export function deduplicateResults(results: readonly RankedResult[]): readonly RankedResult[] {
  const deduplicated = new Map<string, RankedResult>();

  for (const candidate of results) {
    const key = isTorrentProviderResult(candidate.result)
      ? `torrent:${candidate.result.infoHash.toLowerCase()}`
      : `webshare:${candidate.result.fileId}`;
    const existing = deduplicated.get(key);
    if (existing === undefined || candidate.matchScore > existing.matchScore) {
      deduplicated.set(key, candidate);
    }
  }

  return [...deduplicated.values()];
}
