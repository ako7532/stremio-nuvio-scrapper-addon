import { z } from 'zod';

import { calculateV1InfoHash, TorrentMetainfoError } from '../torrent-metainfo.js';
import { readBoundedResponseBody } from './bounded-response-body.js';
import {
  IndexerBackendError,
  type IndexerBackend,
  type IndexerBackendContext,
} from './indexer-backend.js';
import type { IndexerDiscoveryResult, TorznabQuery } from './indexer-types.js';
import { normalizeBtih } from './torrent-identity.js';
import { parseTorznabCapabilities, parseTorznabResults } from './torznab-parser.js';

export type ProwlarrBackendOptions = {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maximumResponseBytes?: number;
  maximumItems?: number;
  maximumTorrentBytes?: number;
};

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAXIMUM_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAXIMUM_ITEMS = 100;
const DEFAULT_MAXIMUM_TORRENT_BYTES = 5 * 1024 * 1024;

const discoverySchema = z.array(
  z.looseObject({
    id: z.number().int().positive(),
    name: z.string().trim().min(1).max(200),
    enable: z.boolean(),
    supportsSearch: z.boolean(),
    protocol: z.enum(['unknown', 'usenet', 'torrent']),
    privacy: z.enum(['public', 'semiPrivate', 'private']),
  }),
);

export const createProwlarrBackend = (options: ProwlarrBackendOptions): IndexerBackend => {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const apiKey = requiredSecret(options.apiKey);
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 'timeout');
  const maximumResponseBytes = positiveInteger(
    options.maximumResponseBytes ?? DEFAULT_MAXIMUM_RESPONSE_BYTES,
    'maximum response size',
  );
  const maximumItems = positiveInteger(
    options.maximumItems ?? DEFAULT_MAXIMUM_ITEMS,
    'maximum items',
  );
  const maximumTorrentBytes = positiveInteger(
    options.maximumTorrentBytes ?? DEFAULT_MAXIMUM_TORRENT_BYTES,
    'maximum torrent size',
  );

  const request = async (
    path: string,
    context: IndexerBackendContext = {},
  ): Promise<{ body: string; contentType: string | undefined }> => {
    const url = new URL(path, baseUrl);
    if (url.origin !== baseUrl.origin) throw new TypeError('Prowlarr request changed origin');
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal =
      context.signal === undefined
        ? timeoutSignal
        : AbortSignal.any([context.signal, timeoutSignal]);
    try {
      const response = await fetchImplementation(url, {
        method: 'GET',
        headers: { accept: 'application/json, application/xml, text/xml', 'X-Api-Key': apiKey },
        credentials: 'omit',
        redirect: 'error',
        signal,
      });
      if (!response.ok) throw responseError(response);
      const bytes = await readBoundedResponseBody(
        response,
        maximumResponseBytes,
        'Prowlarr response',
        invalidResponse,
      );
      return {
        body: new TextDecoder().decode(bytes),
        contentType: response.headers.get('content-type')?.toLowerCase(),
      };
    } catch (error) {
      if (error instanceof IndexerBackendError) throw error;
      if (context.signal?.aborted === true) {
        throw new IndexerBackendError('cancelled', 'Prowlarr request was cancelled', {
          cause: error,
        });
      }
      if (timeoutSignal.aborted) {
        throw new IndexerBackendError('timeout', 'Prowlarr request timed out', { cause: error });
      }
      throw new IndexerBackendError('unavailable', 'Prowlarr request failed', { cause: error });
    }
  };

  return {
    async discover(context) {
      const response = await request('api/v1/indexer', context);
      if (response.contentType !== undefined && !response.contentType.includes('json')) {
        throw invalidResponse('Prowlarr discovery returned an unexpected content type');
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(response.body);
      } catch (error) {
        throw invalidResponse('Prowlarr discovery returned invalid JSON', error);
      }
      const parsed = discoverySchema.safeParse(decoded);
      if (!parsed.success) throw invalidResponse('Prowlarr discovery response is invalid');
      return parsed.data.map((indexer): IndexerDiscoveryResult => ({
        backendId: String(indexer.id),
        name: indexer.name,
        enabled: indexer.enable,
        supportsSearch: indexer.supportsSearch,
        protocol: indexer.protocol,
        privacy: indexer.privacy === 'semiPrivate' ? 'semi-private' : indexer.privacy,
      }));
    },
    async capabilities(indexerId, context) {
      const id = prowlarrIndexerId(indexerId);
      const response = await request(`api/v1/indexer/${id}/newznab?t=caps`, context);
      return parseTorznabCapabilities(response.body, { maximumResponseBytes });
    },
    async search(indexer, query, mediaType, context) {
      const id = prowlarrIndexerId(indexer.backendId);
      const parameters = searchParameters(query, maximumItems);
      const response = await request(
        `api/v1/indexer/${id}/newznab?${parameters.toString()}`,
        context,
      );
      return parseTorznabResults(
        response.body,
        { indexerId: indexer.backendId, indexerName: indexer.name, mediaType },
        { maximumResponseBytes, maximumItems },
      );
    },
    async acquire(indexerId, acquisitionReference, expectedInfoHash, context) {
      const id = prowlarrIndexerId(indexerId);
      const reference = requiredReference(acquisitionReference);
      const parameters = new URLSearchParams({ link: reference });
      const response = await requestBinary(
        new URL(`api/v1/indexer/${id}/download?${parameters.toString()}`, baseUrl),
        apiKey,
        fetchImplementation,
        timeoutMs,
        maximumTorrentBytes,
        context,
      );
      if (
        response.contentType !== undefined &&
        !response.contentType.includes('application/x-bittorrent') &&
        !response.contentType.includes('application/octet-stream')
      ) {
        throw invalidResponse('Prowlarr acquisition returned an unexpected content type');
      }
      let infoHash: string;
      try {
        infoHash = calculateV1InfoHash(response.bytes);
      } catch (error) {
        if (error instanceof TorrentMetainfoError) {
          throw invalidResponse('Prowlarr acquisition returned invalid torrent metainfo', error);
        }
        throw error;
      }
      if (expectedInfoHash !== undefined && normalizeBtih(expectedInfoHash) !== infoHash) {
        throw invalidResponse('Prowlarr acquisition torrent identity does not match');
      }
      return {
        kind: 'file',
        infoHash,
        magnetUri: `magnet:?xt=urn:btih:${infoHash}`,
        torrentFile: response.bytes,
      };
    },
  };
};

const requestBinary = async (
  url: URL,
  apiKey: string,
  fetchImplementation: typeof fetch,
  timeoutMs: number,
  maximumBytes: number,
  context: IndexerBackendContext = {},
): Promise<{ bytes: Uint8Array; contentType: string | undefined }> => {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal =
    context.signal === undefined ? timeoutSignal : AbortSignal.any([context.signal, timeoutSignal]);
  try {
    const response = await fetchImplementation(url, {
      method: 'GET',
      headers: {
        accept: 'application/x-bittorrent, application/octet-stream',
        'X-Api-Key': apiKey,
      },
      credentials: 'omit',
      redirect: 'error',
      signal,
    });
    if (!response.ok) throw responseError(response);
    const body = await readBoundedResponseBody(
      response,
      maximumBytes,
      'Prowlarr torrent file',
      invalidResponse,
      true,
    );
    return {
      bytes: body,
      contentType: response.headers.get('content-type')?.toLowerCase(),
    };
  } catch (error) {
    if (error instanceof IndexerBackendError) throw error;
    if (context.signal?.aborted === true) {
      throw new IndexerBackendError('cancelled', 'Prowlarr acquisition was cancelled', {
        cause: error,
      });
    }
    if (timeoutSignal.aborted) {
      throw new IndexerBackendError('timeout', 'Prowlarr acquisition timed out', { cause: error });
    }
    throw new IndexerBackendError('unavailable', 'Prowlarr acquisition failed', { cause: error });
  }
};

const searchParameters = (query: TorznabQuery, maximumItems: number): URLSearchParams => {
  const parameters = new URLSearchParams({
    t: query.mode,
    extended: '1',
    limit: String(Math.min(100, maximumItems)),
    offset: '0',
  });
  for (const [name, value] of Object.entries(query.parameters)) {
    if (!/^[a-z][a-z\d]*$/u.test(name) || value.length === 0 || value.length > 500) {
      throw new TypeError('Prowlarr search parameter is invalid');
    }
    parameters.set(name, value);
  }
  return parameters;
};

const normalizeBaseUrl = (value: string): URL => {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new TypeError('Prowlarr base URL is invalid');
  }
  if (url.search || url.hash) throw new TypeError('Prowlarr base URL must not contain query data');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
};

const prowlarrIndexerId = (value: string): string => {
  if (!/^[1-9]\d{0,9}$/u.test(value)) throw new TypeError('Prowlarr indexer ID is invalid');
  return value;
};

const requiredSecret = (value: string): string => {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 1_024) {
    throw new TypeError('Prowlarr API key is invalid');
  }
  return normalized;
};

const requiredReference = (value: string): string => {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 4_096 || hasControlCharacter(normalized)) {
    throw new TypeError('Prowlarr acquisition reference is invalid');
  }
  return normalized;
};

const hasControlCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 31 || codeUnit === 127) {
      return true;
    }
  }
  return false;
};

const responseError = (response: Response): IndexerBackendError => {
  const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
  const options = {
    statusCode: response.status,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
  if (response.status === 401 || response.status === 403) {
    return new IndexerBackendError(
      'authentication-failed',
      'Prowlarr authentication failed',
      options,
    );
  }
  if (response.status === 429) {
    return new IndexerBackendError('rate-limited', 'Prowlarr rate limit exceeded', options);
  }
  return new IndexerBackendError('unavailable', 'Prowlarr request failed', options);
};

const parseRetryAfter = (value: string | null): number | undefined => {
  if (value === null || !/^\d+$/u.test(value)) return undefined;
  return Number(value) * 1_000;
};

const invalidResponse = (message: string, cause?: unknown): IndexerBackendError =>
  new IndexerBackendError('invalid-response', message, cause === undefined ? undefined : { cause });

const positiveInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be positive`);
  return value;
};
