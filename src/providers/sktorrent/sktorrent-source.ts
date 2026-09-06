import { parseSktorrentDetail } from './sktorrent-detail-parser.js';
import type { SktorrentHttpClientOptions } from './sktorrent-http-client.js';
import { createSktorrentHttpClient, SktorrentHttpError } from './sktorrent-http-client.js';
import { parseSktorrentListing } from './sktorrent-listing-parser.js';
import type { SktorrentDetail, SktorrentListingResult } from './sktorrent-types.js';
import { SktorrentParserError } from './sktorrent-types.js';
import {
  buildSktorrentListingUrl,
  normalizeSktorrentDetailUrl,
  normalizeSktorrentDownloadUrl,
} from './sktorrent-urls.js';

export type SktorrentCredentials = {
  username: string;
  password: string;
};

export type SktorrentSource = {
  validateAuthentication?(signal?: AbortSignal): Promise<void>;
  search(query: string, signal?: AbortSignal): Promise<readonly SktorrentListingResult[]>;
  getDetail(result: SktorrentListingResult, signal?: AbortSignal): Promise<SktorrentDetail>;
  downloadTorrent(detail: SktorrentDetail, signal?: AbortSignal): Promise<Uint8Array>;
};

export type SktorrentSourceOptions = SktorrentHttpClientOptions & {
  maximumTorrentBytes?: number;
};

const LOGIN_URL = 'https://sktorrent.eu/torrent/login.php';
const ACCOUNT_CHECK_URL = 'https://sktorrent.eu/torrent/';
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAXIMUM_HTML_BYTES = 2_000_000;
const DEFAULT_MAXIMUM_TORRENT_BYTES = 2_000_000;

export const createSktorrentSource = (
  credentials: SktorrentCredentials,
  options: SktorrentSourceOptions = {},
): SktorrentSource => {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const htmlClient = createSktorrentHttpClient(options);
  const maximumTorrentBytes = positiveInteger(
    options.maximumTorrentBytes ?? DEFAULT_MAXIMUM_TORRENT_BYTES,
  );
  const timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const maximumHtmlBytes = positiveInteger(
    options.maximumResponseBytes ?? DEFAULT_MAXIMUM_HTML_BYTES,
  );
  const username = requiredCredential(credentials.username, 'username');
  const password = requiredCredential(credentials.password, 'password');
  let session: Promise<string> | undefined;

  const authenticatedCookie = (): Promise<string> => {
    session ??= authenticate(fetchImplementation, username, password, timeoutMs, maximumHtmlBytes);
    return session.catch((error: unknown) => {
      session = undefined;
      throw error;
    });
  };

  return {
    async validateAuthentication(signal) {
      signal?.throwIfAborted();
      await authenticatedCookie();
      signal?.throwIfAborted();
    },
    async search(query, signal) {
      return parseSktorrentListing(
        await htmlClient.getHtml(buildSktorrentListingUrl(query), signal),
      );
    },

    async getDetail(result, signal) {
      const detailUrl = normalizeSktorrentDetailUrl(result.detailUrl);
      return parseSktorrentDetail(await htmlClient.getHtml(detailUrl, signal), detailUrl);
    },

    async downloadTorrent(detail, signal) {
      const url = normalizeSktorrentDownloadUrl(detail.downloadPath, detail.id);
      const cookie = await authenticatedCookie();
      const requestSignal = combineSignal(signal, timeoutMs);
      const response = await fetchImplementation(url, {
        method: 'GET',
        headers: { accept: 'application/x-bittorrent', cookie },
        credentials: 'omit',
        redirect: 'error',
        signal: requestSignal,
      });
      if (!response.ok) {
        throw new SktorrentHttpError(
          'invalid-response',
          `SKTorrent torrent download returned HTTP ${String(response.status)}`,
          { statusCode: response.status },
        );
      }
      const contentType = response.headers.get('content-type')?.toLowerCase();
      if (!contentType?.includes('application/x-bittorrent')) {
        throw new SktorrentHttpError(
          'invalid-response',
          `SKTorrent torrent download returned unexpected content type: ${contentType ?? 'missing'}`,
        );
      }
      return readBoundedBody(response, maximumTorrentBytes);
    },
  };
};

const authenticate = async (
  fetchImplementation: typeof fetch,
  username: string,
  password: string,
  timeoutMs: number,
  maximumHtmlBytes: number,
): Promise<string> => {
  const login = await fetchImplementation(LOGIN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ uid: username, pwd: password }),
    credentials: 'omit',
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!login.ok) {
    throw new SktorrentHttpError('invalid-response', 'SKTorrent authentication failed', {
      statusCode: login.status,
    });
  }

  const cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(';', 1)[0])
    .filter((value): value is string => value !== undefined && value.length > 0)
    .join('; ');
  if (cookie.length === 0 || /[\r\n]/u.test(cookie)) {
    throw new SktorrentHttpError(
      'invalid-response',
      'SKTorrent authentication returned no session',
    );
  }

  const check = await fetchImplementation(ACCOUNT_CHECK_URL, {
    method: 'GET',
    headers: { accept: 'text/html', cookie },
    credentials: 'omit',
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = new TextDecoder().decode(await readBoundedBody(check, maximumHtmlBytes));
  if (!check.ok || body.includes('Vitaj Guest') || !body.includes('logout.php')) {
    throw new SktorrentHttpError('invalid-response', 'SKTorrent authentication failed');
  }
  return cookie;
};

const readBoundedBody = async (response: Response, maximumBytes: number): Promise<Uint8Array> => {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null && Number(declaredLength) > maximumBytes) {
    throw new SktorrentHttpError('invalid-response', 'SKTorrent torrent metadata is too large');
  }
  const body = new Uint8Array(await response.arrayBuffer());
  if (body.byteLength > maximumBytes) {
    throw new SktorrentHttpError('invalid-response', 'SKTorrent torrent metadata is too large');
  }
  return body;
};

const requiredCredential = (value: string, name: string): string => {
  if (value.trim().length === 0) {
    throw new SktorrentParserError(`SKTorrent ${name} must not be empty`);
  }
  return value;
};

const positiveInteger = (value: number): number => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError('SKTorrent maximum torrent size must be a positive integer');
  }
  return value;
};

const combineSignal = (signal: AbortSignal | undefined, timeoutMs: number): AbortSignal => {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
};
