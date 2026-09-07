import type {
  WebshareAvailability,
  WebshareFileInfo,
  WebshareSearchResult,
} from './webshare-types.js';
import { buildWebshareApiUrl, normalizeWebshareFileId } from './webshare-urls.js';
import {
  parseWebshareAvailability,
  parseWebshareFileInfo,
  parseWebsharePlaybackLink,
  parseWebshareSalt,
  parseWebshareSearch,
  parseWebshareToken,
  WebshareApiError,
} from './webshare-xml.js';

export type WebshareTransportErrorKind =
  'cancelled' | 'timeout' | 'unavailable' | 'invalid-response';

export class WebshareTransportError extends Error {
  override readonly name = 'WebshareTransportError';
  readonly statusCode?: number;

  constructor(
    readonly kind: WebshareTransportErrorKind,
    message: string,
    options?: { statusCode?: number; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    if (options?.statusCode !== undefined) {
      this.statusCode = options.statusCode;
    }
  }
}

export type WebshareApiClient = {
  getSalt(usernameOrEmail: string, signal?: AbortSignal): Promise<string>;
  login(usernameOrEmail: string, passwordDigest: string, signal?: AbortSignal): Promise<string>;
  search(
    query: string,
    limit: number,
    sessionToken: string,
    signal?: AbortSignal,
  ): Promise<readonly WebshareSearchResult[]>;
  getFileInfo(fileId: string, signal?: AbortSignal): Promise<WebshareFileInfo>;
  getAvailability(fileId: string, signal?: AbortSignal): Promise<WebshareAvailability>;
  getPlaybackLink(fileId: string, sessionToken: string, signal?: AbortSignal): Promise<string>;
};

export type WebshareApiClientOptions = {
  fetch?: typeof fetch;
  timeoutMs?: number;
  maximumResponseBytes?: number;
};

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAXIMUM_RESPONSE_BYTES = 1_000_000;

export const createWebshareApiClient = (
  options: WebshareApiClientOptions = {},
): WebshareApiClient => {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 'timeout');
  const maximumResponseBytes = positiveInteger(
    options.maximumResponseBytes ?? DEFAULT_MAXIMUM_RESPONSE_BYTES,
    'maximum response size',
  );

  const post = async (
    operation: Parameters<typeof buildWebshareApiUrl>[0],
    fields: Readonly<Record<string, string>>,
    signal?: AbortSignal,
    sessionToken?: string,
  ): Promise<string> => {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const requestSignal =
      signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
    const token =
      sessionToken === undefined ? undefined : requiredSecret(sessionToken, 'session token');

    try {
      const response = await fetchImplementation(buildWebshareApiUrl(operation), {
        method: 'POST',
        headers: {
          accept: 'text/xml; charset=UTF-8',
          'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        },
        body: new URLSearchParams({ ...fields, ...(token === undefined ? {} : { wst: token }) }),
        credentials: 'omit',
        redirect: 'error',
        signal: requestSignal,
      });
      if (!response.ok) {
        throw new WebshareTransportError(
          'invalid-response',
          `Webshare returned HTTP ${String(response.status)}`,
          { statusCode: response.status },
        );
      }
      const contentType = response.headers.get('content-type')?.toLowerCase();
      if (contentType !== undefined && !contentType.includes('xml')) {
        throw new WebshareTransportError(
          'invalid-response',
          `Webshare returned unexpected content type: ${contentType}`,
        );
      }
      const declaredLength = parseContentLength(response.headers.get('content-length'));
      if (declaredLength !== undefined && declaredLength > maximumResponseBytes) {
        throw responseTooLarge(maximumResponseBytes);
      }
      const body = await response.arrayBuffer();
      if (body.byteLength > maximumResponseBytes) {
        throw responseTooLarge(maximumResponseBytes);
      }
      return new TextDecoder().decode(body);
    } catch (error) {
      if (error instanceof WebshareTransportError || error instanceof WebshareApiError) {
        throw error;
      }
      if (signal?.aborted === true) {
        throw new WebshareTransportError('cancelled', 'Webshare request was cancelled', {
          cause: error,
        });
      }
      if (timeoutSignal.aborted) {
        throw new WebshareTransportError(
          'timeout',
          `Webshare request timed out after ${String(timeoutMs)} ms`,
          { cause: error },
        );
      }
      throw new WebshareTransportError('unavailable', 'Webshare request failed', { cause: error });
    }
  };

  return {
    async getSalt(usernameOrEmail, signal) {
      return parseWebshareSalt(
        await post(
          'salt',
          { username_or_email: requiredSecret(usernameOrEmail, 'username') },
          signal,
        ),
      );
    },
    async login(usernameOrEmail, passwordDigest, signal) {
      return parseWebshareToken(
        await post(
          'login',
          {
            username_or_email: requiredSecret(usernameOrEmail, 'username'),
            password: requiredSecret(passwordDigest, 'password digest'),
            keep_logged_in: '0',
          },
          signal,
        ),
      );
    },
    async search(query, limit, sessionToken, signal) {
      return parseWebshareSearch(
        await post(
          'search',
          {
            what: requiredQuery(query),
            sort: 'rating',
            limit: String(positiveInteger(limit, 'search limit')),
            offset: '0',
            category: 'video',
          },
          signal,
          sessionToken,
        ),
      );
    },
    async getFileInfo(fileId, signal) {
      const id = normalizeWebshareFileId(fileId);
      return parseWebshareFileInfo(await post('file_info', { ident: id }, signal), id);
    },
    async getAvailability(fileId, signal) {
      return parseWebshareAvailability(
        await post('file_exists', { ident: normalizeWebshareFileId(fileId) }, signal),
      );
    },
    async getPlaybackLink(fileId, sessionToken, signal) {
      return parseWebsharePlaybackLink(
        await post(
          'file_link',
          {
            ident: normalizeWebshareFileId(fileId),
            download_type: 'video_stream',
            force_https: '1',
          },
          signal,
          sessionToken,
        ),
      );
    },
  };
};

const requiredSecret = (value: string, name: string): string => {
  if (value.trim().length === 0 || /[\r\n;]/u.test(value)) {
    throw new TypeError(`Invalid Webshare ${name}`);
  }
  return value;
};

const requiredQuery = (value: string): string => {
  const query = value.trim();
  if (query.length === 0) {
    throw new TypeError('Webshare search query must not be empty');
  }
  return query;
};

const positiveInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`Webshare ${name} must be a positive integer`);
  }
  return value;
};

const parseContentLength = (value: string | null): number | undefined => {
  if (value === null || !/^\d+$/u.test(value)) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
};

const responseTooLarge = (maximumResponseBytes: number): WebshareTransportError =>
  new WebshareTransportError(
    'invalid-response',
    `Webshare response exceeds ${String(maximumResponseBytes)} bytes`,
  );
