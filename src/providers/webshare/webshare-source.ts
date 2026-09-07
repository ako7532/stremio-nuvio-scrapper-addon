import type { WebshareApiClient } from './webshare-api-client.js';
import type { WebshareCredentialService } from './webshare-credentials.js';
import type { WebshareFile, WebshareSearchResult } from './webshare-types.js';
import { buildWebshareFileUrl, normalizeWebshareFileId } from './webshare-urls.js';

export type WebshareSource = {
  search(query: string, signal?: AbortSignal): Promise<readonly WebshareFile[]>;
  resolvePlayback(fileId: string, signal?: AbortSignal): Promise<string>;
};

export type WebshareSourceOptions = {
  maximumResults?: number;
  detailConcurrency?: number;
};

export const createWebshareSource = (
  api: WebshareApiClient,
  credentials: WebshareCredentialService,
  options: WebshareSourceOptions = {},
): WebshareSource => {
  const maximumResults = positiveInteger(options.maximumResults ?? 20, 'maximum results');
  const detailConcurrency = positiveInteger(options.detailConcurrency ?? 4, 'detail concurrency');

  return {
    async search(query, signal) {
      const token = await credentials.getSessionToken(signal);
      const results = await api.search(query, maximumResults, token, signal);
      const candidates = results
        .filter((result) => !result.passwordProtected)
        .slice(0, maximumResults);
      const settlements = await mapWithConcurrency(
        candidates,
        detailConcurrency,
        async (result) => {
          try {
            return { status: 'fulfilled' as const, value: await enrichResult(api, result, signal) };
          } catch (reason) {
            signal?.throwIfAborted();
            return { status: 'rejected' as const, reason };
          }
        },
      );
      const files = settlements.flatMap((settlement) =>
        settlement.status === 'fulfilled' ? [settlement.value] : [],
      );
      if (files.length > 0 || settlements.length === 0) return files;
      const failure = settlements.find((settlement) => settlement.status === 'rejected');
      if (failure === undefined) return [];
      throw failure.reason;
    },
    async resolvePlayback(fileId, signal) {
      const id = normalizeWebshareFileId(fileId);
      const token = await credentials.getSessionToken(signal);
      return api.getPlaybackLink(id, token, signal);
    },
  };
};

const enrichResult = async (
  api: WebshareApiClient,
  result: WebshareSearchResult,
  signal?: AbortSignal,
): Promise<WebshareFile> => {
  const [info, availability] = await Promise.all([
    api.getFileInfo(result.id, signal),
    api.getAvailability(result.id, signal),
  ]);
  const available =
    availability.exists && availability.downloadable && info.available && !info.removed;
  return {
    ...info,
    available,
    streamable: available && !info.passwordProtected && !info.copyrighted,
    providerUrl: buildWebshareFileUrl(info.id),
  };
};

const mapWithConcurrency = async <Input, Output>(
  values: readonly Input[],
  concurrency: number,
  mapper: (value: Input) => Promise<Output>,
): Promise<readonly Output[]> => {
  const results = new Array<Output>(values.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      const value = values[index];
      if (value !== undefined) results[index] = await mapper(value);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
};

const positiveInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`Webshare source ${name} must be a positive integer`);
  }
  return value;
};
