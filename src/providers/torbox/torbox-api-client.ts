import { z } from 'zod';

import type {
  TorboxCacheEntry,
  TorboxCreatedTorrent,
  TorboxTorrent,
  TorboxTorrentFile,
} from './torbox-types.js';

export type TorboxTransportErrorKind =
  | 'authentication-failed'
  | 'cancelled'
  | 'timeout'
  | 'rate-limited'
  | 'unavailable'
  | 'invalid-response';

export class TorboxTransportError extends Error {
  override readonly name = 'TorboxTransportError';
  readonly statusCode?: number;
  readonly retryAfterMs?: number;
  readonly errorCode?: string;

  constructor(
    readonly kind: TorboxTransportErrorKind,
    message: string,
    options?: {
      statusCode?: number;
      retryAfterMs?: number;
      errorCode?: string;
      cause?: unknown;
    },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    if (options?.statusCode !== undefined) this.statusCode = options.statusCode;
    if (options?.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
    if (options?.errorCode !== undefined) this.errorCode = options.errorCode;
  }
}

export type TorboxApiClient = {
  validateAuthentication(signal?: AbortSignal): Promise<void>;
  checkCached(
    hashes: readonly string[],
    signal?: AbortSignal,
  ): Promise<readonly TorboxCacheEntry[]>;
  listTorrents(signal?: AbortSignal): Promise<readonly TorboxTorrent[]>;
  getTorrent(torrentId: number, signal?: AbortSignal): Promise<TorboxTorrent>;
  createTorrent(magnetUri: string, signal?: AbortSignal): Promise<TorboxCreatedTorrent>;
  createTorrentFile?(torrentFile: Uint8Array, signal?: AbortSignal): Promise<TorboxCreatedTorrent>;
  requestDownloadLink(torrentId: number, fileId: number, signal?: AbortSignal): Promise<string>;
};

export type TorboxApiClientOptions = {
  apiKey: string;
  fetch?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
  maximumResponseBytes?: number;
  maximumCacheBatchSize?: number;
};

const envelopeSchema = z.looseObject({
  success: z.boolean(),
  data: z.unknown().optional(),
  detail: z.string().nullish(),
  error: z.string().nullish(),
});
const DEFAULT_BASE_URL = 'https://api.torbox.app/v1/api/';
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAXIMUM_RESPONSE_BYTES = 2_000_000;
const DEFAULT_MAXIMUM_CACHE_BATCH_SIZE = 100;
const INFO_HASH = /^[a-f\d]{40}$/iu;

export const createTorboxApiClient = (options: TorboxApiClientOptions): TorboxApiClient => {
  const apiKey = requiredSecret(options.apiKey, 'API key');
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const baseUrl = validateBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
  const timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 'timeout');
  const maximumResponseBytes = positiveInteger(
    options.maximumResponseBytes ?? DEFAULT_MAXIMUM_RESPONSE_BYTES,
    'maximum response size',
  );
  const maximumCacheBatchSize = positiveInteger(
    options.maximumCacheBatchSize ?? DEFAULT_MAXIMUM_CACHE_BATCH_SIZE,
    'maximum cache batch size',
  );

  const request = async (
    path: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof envelopeSchema>> => {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const requestSignal =
      signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
    try {
      const headers = new Headers(init.headers);
      headers.set('accept', 'application/json');
      headers.set('authorization', `Bearer ${apiKey}`);
      const response = await fetchImplementation(new URL(path, baseUrl), {
        ...init,
        headers,
        credentials: 'omit',
        redirect: 'error',
        signal: requestSignal,
      });
      if (!response.ok) throw await httpError(response);
      const contentType = response.headers.get('content-type')?.toLowerCase();
      if (contentType !== undefined && !contentType.includes('json')) {
        throw invalidResponse(`TorBox returned unexpected content type: ${contentType}`);
      }
      const declaredLength = parseContentLength(response.headers.get('content-length'));
      if (declaredLength !== undefined && declaredLength > maximumResponseBytes) {
        throw responseTooLarge(maximumResponseBytes);
      }
      const body = await response.arrayBuffer();
      if (body.byteLength > maximumResponseBytes) throw responseTooLarge(maximumResponseBytes);
      let decoded: unknown;
      try {
        decoded = JSON.parse(new TextDecoder().decode(body));
      } catch (error) {
        throw invalidResponse('TorBox returned invalid JSON', error);
      }
      const parsed = envelopeSchema.safeParse(decoded);
      if (!parsed.success) throw invalidResponse('TorBox returned an invalid response envelope');
      if (!parsed.data.success) {
        const detail = parsed.data.detail ?? 'TorBox rejected the request';
        const errorCode = normalizeSafeErrorCode(parsed.data.error);
        if (errorCode !== undefined && /(?:AUTH|TOKEN|CREDENTIAL|UNAUTHOR)/u.test(errorCode)) {
          throw new TorboxTransportError('authentication-failed', 'TorBox authentication failed', {
            errorCode,
          });
        }
        throw new TorboxTransportError('invalid-response', detail, {
          ...(errorCode === undefined ? {} : { errorCode }),
        });
      }
      return parsed.data;
    } catch (error) {
      if (error instanceof TorboxTransportError) throw error;
      if (signal?.aborted === true) {
        throw new TorboxTransportError('cancelled', 'TorBox request was cancelled', {
          cause: error,
        });
      }
      if (timeoutSignal.aborted) {
        throw new TorboxTransportError(
          'timeout',
          `TorBox request timed out after ${String(timeoutMs)} ms`,
          { cause: error },
        );
      }
      throw new TorboxTransportError('unavailable', 'TorBox request failed', { cause: error });
    }
  };

  return {
    async validateAuthentication(signal) {
      await request('user/me', { method: 'GET' }, signal);
    },
    async checkCached(hashes, signal) {
      const normalized = [...new Set(hashes.map(normalizeInfoHash))];
      if (normalized.length === 0) return [];
      if (normalized.length > maximumCacheBatchSize) {
        throw new RangeError(
          `TorBox cache batch cannot exceed ${String(maximumCacheBatchSize)} hashes`,
        );
      }
      const response = await request(
        'torrents/checkcached',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ hashes: normalized }),
        },
        signal,
      );
      return parseCacheEntries(normalized, response.data);
    },
    async listTorrents(signal) {
      const response = await request('torrents/mylist?limit=1000', { method: 'GET' }, signal);
      if (!Array.isArray(response.data)) {
        throw invalidResponse('TorBox torrent list is not an array');
      }
      return response.data.map(parseTorrent);
    },
    async getTorrent(torrentId, signal) {
      const id = positiveInteger(torrentId, 'torrent ID');
      const response = await request(
        `torrents/mylist?id=${encodeURIComponent(String(id))}&bypass_cache=true`,
        { method: 'GET' },
        signal,
      );
      const data: unknown = response.data;
      const value: unknown = Array.isArray(data) ? (data as unknown[])[0] : data;
      if (value === undefined) throw invalidResponse('TorBox torrent was not found');
      return parseTorrent(value);
    },
    async createTorrent(magnetUri, signal) {
      const magnet = validateMagnetUri(magnetUri);
      const body = new FormData();
      body.set('magnet', magnet);
      body.set('allow_zip', 'false');
      const response = await request('torrents/createtorrent', { method: 'POST', body }, signal);
      return parseCreatedTorrent(response.data);
    },
    async createTorrentFile(torrentFile, signal) {
      if (torrentFile.byteLength === 0)
        throw new TypeError('TorBox torrent file must not be empty');
      const bytes = torrentFile.slice();
      const body = new FormData();
      body.set(
        'file',
        new Blob([bytes.buffer], { type: 'application/x-bittorrent' }),
        'upload.torrent',
      );
      body.set('allow_zip', 'false');
      const response = await request('torrents/createtorrent', { method: 'POST', body }, signal);
      return parseCreatedTorrent(response.data);
    },
    async requestDownloadLink(torrentId, fileId, signal) {
      const parameters = new URLSearchParams({
        // TorBox pre tento endpoint vyžaduje token v query aj pri Bearer autorizácii.
        token: apiKey,
        torrent_id: String(positiveInteger(torrentId, 'torrent ID')),
        file_id: String(nonNegativeInteger(fileId, 'file ID')),
        zip_link: 'false',
      });
      const response = await request(
        `torrents/requestdl?${parameters.toString()}`,
        { method: 'GET' },
        signal,
      );
      if (typeof response.data !== 'string') {
        throw invalidResponse('TorBox download link is missing');
      }
      return response.data;
    },
  };
};

const parseCacheEntries = (
  requestedHashes: readonly string[],
  value: unknown,
): readonly TorboxCacheEntry[] => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidResponse('TorBox cache result is not an object');
  }
  const entries = value as Record<string, unknown>;
  return requestedHashes.map((hash) => {
    const exactKey = Object.keys(entries).find((candidate) => candidate.toLowerCase() === hash);
    if (exactKey === undefined) return { hash, status: 'uncached' };
    const cached = entries[exactKey];
    return {
      hash,
      status: cached !== null && typeof cached === 'object' ? 'cached' : 'unknown',
    };
  });
};

const parseCreatedTorrent = (value: unknown): TorboxCreatedTorrent => {
  const data = record(value, 'TorBox create-torrent data');
  const id = integerField(data, ['torrent_id', 'id'], 'TorBox torrent ID');
  const hash = optionalStringField(data, ['hash']);
  return {
    id: positiveInteger(id, 'torrent ID'),
    ...(hash === undefined ? {} : { hash: normalizeInfoHash(hash) }),
  };
};

const parseTorrent = (value: unknown): TorboxTorrent => {
  const data = record(value, 'TorBox torrent');
  const filesValue = data['files'];
  if (filesValue !== undefined && filesValue !== null && !Array.isArray(filesValue)) {
    throw invalidResponse('TorBox torrent files are not an array');
  }
  return {
    id: positiveInteger(
      integerField(data, ['id', 'torrent_id'], 'TorBox torrent ID'),
      'torrent ID',
    ),
    hash: normalizeInfoHash(stringField(data, ['hash'], 'TorBox torrent hash')),
    name: stringField(data, ['name'], 'TorBox torrent name'),
    downloadState: stringField(data, ['download_state', 'downloadState'], 'TorBox download state'),
    ...optionalBooleanProperties(data),
    files: Array.isArray(filesValue) ? filesValue.map(parseTorrentFile) : [],
  };
};

const optionalBooleanProperties = (
  data: Record<string, unknown>,
): Pick<TorboxTorrent, 'downloadFinished' | 'downloadPresent'> => {
  const downloadFinished = optionalBooleanField(data, ['download_finished', 'downloadFinished']);
  const downloadPresent = optionalBooleanField(data, ['download_present', 'downloadPresent']);
  return {
    ...(downloadFinished === undefined ? {} : { downloadFinished }),
    ...(downloadPresent === undefined ? {} : { downloadPresent }),
  };
};

const parseTorrentFile = (value: unknown): TorboxTorrentFile => {
  const data = record(value, 'TorBox torrent file');
  const size = optionalIntegerField(data, ['size']);
  return {
    id: nonNegativeInteger(integerField(data, ['id', 'file_id'], 'TorBox file ID'), 'file ID'),
    name: stringField(data, ['name', 'short_name'], 'TorBox file name'),
    ...(size === undefined ? {} : { sizeBytes: nonNegativeInteger(size, 'file size') }),
  };
};

const httpError = async (response: Response): Promise<TorboxTransportError> => {
  const statusCode = response.status;
  const errorCode = await readSafeErrorCode(response);
  const errorOptions = {
    statusCode,
    ...(errorCode === undefined ? {} : { errorCode }),
  };
  if (statusCode === 401 || statusCode === 403) {
    return new TorboxTransportError(
      'authentication-failed',
      'TorBox authentication failed',
      errorOptions,
    );
  }
  if (statusCode === 429) {
    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
    return new TorboxTransportError('rate-limited', 'TorBox rate limit exceeded', {
      ...errorOptions,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
  }
  return new TorboxTransportError(
    'unavailable',
    `TorBox returned HTTP ${String(statusCode)}`,
    errorOptions,
  );
};

const readSafeErrorCode = async (response: Response): Promise<string | undefined> => {
  try {
    const value: unknown = await response.json();
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    return normalizeSafeErrorCode((value as Record<string, unknown>)['error']);
  } catch {
    return undefined;
  }
};

const normalizeSafeErrorCode = (value: unknown): string | undefined =>
  typeof value === 'string' && /^[a-z][a-z\d_-]{0,63}$/iu.test(value)
    ? value.toUpperCase()
    : undefined;

const parseRetryAfter = (value: string | null, now = Date.now()): number | undefined => {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
};

const parseContentLength = (value: string | null): number | undefined => {
  if (value === null || !/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
};

const responseTooLarge = (maximum: number): TorboxTransportError =>
  invalidResponse(`TorBox response exceeded ${String(maximum)} bytes`);

const invalidResponse = (message: string, cause?: unknown): TorboxTransportError =>
  new TorboxTransportError(
    'invalid-response',
    message,
    cause === undefined ? undefined : { cause },
  );

const validateBaseUrl = (value: string): URL => {
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new TypeError('TorBox API base URL must use HTTPS');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  url.search = '';
  url.hash = '';
  return url;
};

const validateMagnetUri = (value: string): string => {
  const normalized = value.trim();
  if (!/^magnet:\?xt=urn:btih:[a-f\d]{40}(?:&|$)/iu.test(normalized)) {
    throw new TypeError('TorBox magnet URI must contain a BitTorrent v1 info hash');
  }
  return normalized;
};

const normalizeInfoHash = (value: string): string => {
  const normalized = value.trim().toLowerCase();
  if (!INFO_HASH.test(normalized)) throw new TypeError('Invalid BitTorrent v1 info hash');
  return normalized;
};

const requiredSecret = (value: string, name: string): string => {
  const normalized = value.trim();
  if (normalized.length === 0) throw new TypeError(`TorBox ${name} is required`);
  return normalized;
};

const positiveInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be positive`);
  return value;
};

const nonNegativeInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
  return value;
};

const record = (value: unknown, name: string): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidResponse(`${name} is not an object`);
  }
  return value as Record<string, unknown>;
};

const integerField = (
  value: Record<string, unknown>,
  names: readonly string[],
  label: string,
): number => {
  for (const name of names) {
    const candidate = value[name];
    if (typeof candidate === 'number' && Number.isSafeInteger(candidate)) return candidate;
    if (typeof candidate === 'string' && /^\d+$/u.test(candidate)) return Number(candidate);
  }
  throw invalidResponse(`${label} is missing`);
};

const optionalIntegerField = (
  value: Record<string, unknown>,
  names: readonly string[],
): number | undefined => {
  for (const name of names) {
    const candidate = value[name];
    if (typeof candidate === 'number' && Number.isSafeInteger(candidate)) return candidate;
    if (typeof candidate === 'string' && /^\d+$/u.test(candidate)) return Number(candidate);
  }
  return undefined;
};

const optionalBooleanField = (
  value: Record<string, unknown>,
  names: readonly string[],
): boolean | undefined => {
  for (const name of names) {
    const candidate = value[name];
    if (typeof candidate === 'boolean') return candidate;
  }
  return undefined;
};

const stringField = (
  value: Record<string, unknown>,
  names: readonly string[],
  label: string,
): string => {
  const candidate = optionalStringField(value, names);
  if (candidate === undefined) throw invalidResponse(`${label} is missing`);
  return candidate;
};

const optionalStringField = (
  value: Record<string, unknown>,
  names: readonly string[],
): string | undefined => {
  for (const name of names) {
    const candidate = value[name];
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return undefined;
};
