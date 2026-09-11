import { calculateV1InfoHash, TorrentMetainfoError } from '../torrent-metainfo.js';
import { readBoundedResponseBody } from './bounded-response-body.js';
import {
  IndexerBackendError,
  type AcquiredTorrent,
  type IndexerBackend,
  type IndexerBackendContext,
} from './indexer-backend.js';
import type { IndexerSearchResult, TorznabQuery } from './indexer-types.js';
import { parseJackettDiscovery } from './jackett-discovery-parser.js';
import { identityFromMagnet, normalizeBtih, TorrentIdentityError } from './torrent-identity.js';
import { parseTorznabCapabilities, parseTorznabResults } from './torznab-parser.js';

export type JackettBackendOptions = {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maximumResponseBytes?: number;
  maximumItems?: number;
  maximumIndexers?: number;
  maximumTorrentBytes?: number;
};

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAXIMUM_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAXIMUM_ITEMS = 100;
const DEFAULT_MAXIMUM_INDEXERS = 100;
const DEFAULT_MAXIMUM_TORRENT_BYTES = 5 * 1024 * 1024;

export const createJackettBackend = (options: JackettBackendOptions): IndexerBackend => {
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
  const maximumIndexers = positiveInteger(
    options.maximumIndexers ?? DEFAULT_MAXIMUM_INDEXERS,
    'maximum indexers',
  );
  const maximumTorrentBytes = positiveInteger(
    options.maximumTorrentBytes ?? DEFAULT_MAXIMUM_TORRENT_BYTES,
    'maximum torrent size',
  );

  const requestText = async (
    path: string,
    parameters: URLSearchParams,
    context: IndexerBackendContext = {},
  ): Promise<string> => {
    parameters.set('apikey', apiKey);
    const url = backendUrl(baseUrl, path, parameters);
    const response = await request(url, fetchImplementation, timeoutMs, context, 'text');
    if (!response.ok) throw responseError(response);
    const bytes = await boundedBody(response, maximumResponseBytes, 'Jackett response');
    return new TextDecoder().decode(bytes);
  };

  return {
    async discover(context) {
      const xml = await requestText(
        'api/v2.0/indexers/all/results/torznab/api',
        new URLSearchParams({ t: 'indexers', configured: 'true' }),
        context,
      );
      try {
        return parseJackettDiscovery(xml, { maximumResponseBytes, maximumIndexers });
      } catch (error) {
        throw invalidResponse('Jackett discovery response is invalid', error);
      }
    },
    async capabilities(indexerId, context) {
      const id = jackettIndexerId(indexerId);
      const xml = await requestText(
        `api/v2.0/indexers/${id}/results/torznab/api`,
        new URLSearchParams({ t: 'caps' }),
        context,
      );
      try {
        return parseTorznabCapabilities(xml, { maximumResponseBytes });
      } catch (error) {
        throw invalidResponse('Jackett capabilities response is invalid', error);
      }
    },
    async search(indexer, query, mediaType, context) {
      const id = jackettIndexerId(indexer.backendId);
      const xml = await requestText(
        `api/v2.0/indexers/${id}/results/torznab/api`,
        searchParameters(query, maximumItems),
        context,
      );
      let parsed: readonly IndexerSearchResult[];
      try {
        parsed = parseTorznabResults(
          xml,
          { indexerId: indexer.backendId, indexerName: indexer.name, mediaType },
          { maximumResponseBytes, maximumItems },
        );
      } catch (error) {
        throw invalidResponse('Jackett search response is invalid', error);
      }
      return parsed.map((result) => sanitizeSearchResult(result, baseUrl, id));
    },
    async acquire(indexerId, acquisitionReference, expectedInfoHash, context) {
      const id = jackettIndexerId(indexerId);
      const reference = decodeReference(acquisitionReference);
      const parameters = new URLSearchParams({ path: reference.path, jackett_apikey: apiKey });
      if (reference.file !== undefined) parameters.set('file', reference.file);
      const url = backendUrl(baseUrl, `dl/${id}`, parameters);
      const response = await request(
        url,
        fetchImplementation,
        timeoutMs,
        context ?? {},
        'acquisition',
      );
      if (isRedirect(response.status)) {
        return magnetFromRedirect(response, expectedInfoHash);
      }
      if (!response.ok) throw responseError(response);
      const contentType = response.headers.get('content-type')?.toLowerCase();
      if (
        contentType !== undefined &&
        !contentType.includes('application/x-bittorrent') &&
        !contentType.includes('application/octet-stream')
      ) {
        throw invalidResponse('Jackett acquisition returned an unexpected content type');
      }
      const bytes = await boundedBody(response, maximumTorrentBytes, 'Jackett torrent file', true);
      let infoHash: string;
      try {
        infoHash = calculateV1InfoHash(bytes);
      } catch (error) {
        if (error instanceof TorrentMetainfoError) {
          throw invalidResponse('Jackett acquisition returned invalid torrent metainfo', error);
        }
        throw error;
      }
      assertExpectedIdentity(infoHash, expectedInfoHash);
      return {
        kind: 'file',
        infoHash,
        magnetUri: `magnet:?xt=urn:btih:${infoHash}`,
        torrentFile: bytes,
      };
    },
  };
};

const sanitizeSearchResult = (
  result: IndexerSearchResult,
  baseUrl: URL,
  indexerId: string,
): IndexerSearchResult => {
  if (result.acquisitionReference === undefined) return result;
  const { acquisitionReference: rawReference, ...safeResult } = result;
  try {
    const url = new URL(rawReference, baseUrl);
    if (url.origin !== baseUrl.origin || url.pathname !== `${baseUrl.pathname}dl/${indexerId}`) {
      return safeResult;
    }
    const path = requiredReferencePart(url.searchParams.get('path'), 'path', 4_096);
    const fileValue = url.searchParams.get('file');
    const file = fileValue === null ? undefined : requiredReferencePart(fileValue, 'file', 255);
    return {
      ...safeResult,
      acquisitionReference: encodeReference({ path, ...(file === undefined ? {} : { file }) }),
    };
  } catch {
    return safeResult;
  }
};

type SafeReference = { path: string; file?: string };

const encodeReference = (reference: SafeReference): string =>
  Buffer.from(JSON.stringify(reference), 'utf8').toString('base64url');

const decodeReference = (value: string): SafeReference => {
  if (!/^[A-Za-z\d_-]{1,8192}$/u.test(value))
    throw new TypeError('Jackett acquisition reference is invalid');
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new TypeError('Jackett acquisition reference is invalid');
  }
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
    throw new TypeError('Jackett acquisition reference is invalid');
  }
  const record = decoded as Record<string, unknown>;
  const path = requiredReferencePart(record['path'], 'path', 4_096);
  const file =
    record['file'] === undefined ? undefined : requiredReferencePart(record['file'], 'file', 255);
  return { path, ...(file === undefined ? {} : { file }) };
};

const requiredReferencePart = (value: unknown, name: string, maximum: number): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) {
    throw new TypeError(`Jackett acquisition ${name} is invalid`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 31 || codeUnit === 127) {
      throw new TypeError(`Jackett acquisition ${name} is invalid`);
    }
  }
  return value;
};

const request = async (
  url: URL,
  fetchImplementation: typeof fetch,
  timeoutMs: number,
  context: IndexerBackendContext,
  operation: 'text' | 'acquisition',
): Promise<Response> => {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal =
    context.signal === undefined ? timeoutSignal : AbortSignal.any([context.signal, timeoutSignal]);
  try {
    return await fetchImplementation(url, {
      method: 'GET',
      headers: {
        accept:
          operation === 'text'
            ? 'application/xml, text/xml, application/rss+xml'
            : 'application/x-bittorrent, application/octet-stream',
      },
      credentials: 'omit',
      redirect: 'manual',
      signal,
    });
  } catch (error) {
    if (context.signal?.aborted === true) {
      throw new IndexerBackendError('cancelled', 'Jackett request was cancelled', { cause: error });
    }
    if (timeoutSignal.aborted) {
      throw new IndexerBackendError('timeout', 'Jackett request timed out', { cause: error });
    }
    throw new IndexerBackendError('unavailable', 'Jackett request failed', { cause: error });
  }
};

const boundedBody = async (
  response: Response,
  maximumBytes: number,
  label: string,
  requireNonEmpty = false,
): Promise<Uint8Array> => {
  return readBoundedResponseBody(response, maximumBytes, label, invalidResponse, requireNonEmpty);
};

const magnetFromRedirect = (response: Response, expectedInfoHash?: string): AcquiredTorrent => {
  const location = response.headers.get('location');
  if (location === null) throw invalidResponse('Jackett acquisition redirect has no location');
  let infoHash: string;
  try {
    infoHash = identityFromMagnet(location).infoHash;
  } catch (error) {
    if (error instanceof TorrentIdentityError) {
      throw invalidResponse('Jackett acquisition redirect is not a supported magnet', error);
    }
    throw error;
  }
  assertExpectedIdentity(infoHash, expectedInfoHash);
  return { kind: 'magnet', infoHash, magnetUri: location };
};

const assertExpectedIdentity = (actual: string, expected: string | undefined): void => {
  if (expected === undefined) return;
  try {
    if (normalizeBtih(expected) !== actual) {
      throw invalidResponse('Jackett acquisition torrent identity does not match');
    }
  } catch (error) {
    if (error instanceof IndexerBackendError) throw error;
    throw invalidResponse('Jackett expected torrent identity is invalid', error);
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
      throw new TypeError('Jackett search parameter is invalid');
    }
    parameters.set(name, value);
  }
  return parameters;
};

const backendUrl = (baseUrl: URL, path: string, parameters: URLSearchParams): URL => {
  const url = new URL(path, baseUrl);
  if (url.origin !== baseUrl.origin) throw new TypeError('Jackett request changed origin');
  url.search = parameters.toString();
  return url;
};

const normalizeBaseUrl = (value: string): URL => {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new TypeError('Jackett base URL is invalid');
  }
  if (url.search || url.hash) throw new TypeError('Jackett base URL must not contain query data');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
};

const jackettIndexerId = (value: string): string => {
  if (!/^[a-z\d][a-z\d._-]{0,99}$/iu.test(value))
    throw new TypeError('Jackett indexer ID is invalid');
  return value;
};

const requiredSecret = (value: string): string => {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 1_024)
    throw new TypeError('Jackett API key is invalid');
  return normalized;
};

const isRedirect = (status: number): boolean => [301, 302, 303, 307, 308].includes(status);

const responseError = (response: Response): IndexerBackendError => {
  const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
  const options = {
    statusCode: response.status,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
  if (response.status === 401 || response.status === 403) {
    return new IndexerBackendError(
      'authentication-failed',
      'Jackett authentication failed',
      options,
    );
  }
  if (response.status === 429)
    return new IndexerBackendError('rate-limited', 'Jackett rate limit exceeded', options);
  return new IndexerBackendError('unavailable', 'Jackett request failed', options);
};

const parseRetryAfter = (value: string | null): number | undefined =>
  value !== null && /^\d+$/u.test(value) ? Number(value) * 1_000 : undefined;

const invalidResponse = (message: string, cause?: unknown): IndexerBackendError =>
  new IndexerBackendError('invalid-response', message, cause === undefined ? undefined : { cause });

const positiveInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be positive`);
  return value;
};
