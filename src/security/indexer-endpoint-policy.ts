import { lookup as lookupDns } from 'node:dns/promises';
import { request as requestHttp } from 'node:http';
import { request as requestHttps } from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';

export type IndexerResolvedAddress = { address: string; family: 4 | 6 };

export type IndexerEndpointPolicy = {
  assertAllowed(endpoint: string): URL;
  request: typeof fetch;
};

export type IndexerEndpointPolicyOptions = {
  lookup?: (hostname: string) => Promise<readonly IndexerResolvedAddress[]>;
  connect?: (url: URL, init: RequestInit, resolved: IndexerResolvedAddress) => Promise<Response>;
};

export const createIndexerEndpointPolicy = (
  allowedOrigins: readonly string[],
  options: IndexerEndpointPolicyOptions = {},
): IndexerEndpointPolicy => {
  const allowed = new Map(
    allowedOrigins.map((origin) => {
      const normalized = normalizeOrigin(origin);
      return [normalized.url.origin, normalized] as const;
    }),
  );
  const lookup = options.lookup ?? systemLookup;
  const connect = options.connect ?? pinnedRequest;

  const assertAllowed = (endpoint: string): URL => {
    const url = normalizeEndpoint(endpoint);
    if (!allowed.has(url.origin)) {
      throw new TypeError('Indexer endpoint origin is not allowed by the server');
    }
    return url;
  };

  return {
    assertAllowed,
    request: async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = requestUrl(input);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
        throw new TypeError('Indexer request URL is invalid');
      }
      const approved = allowed.get(url.origin);
      if (approved === undefined) throw new TypeError('Indexer endpoint origin is not allowed');
      const addresses = await resolveAddresses(url.hostname, lookup);
      if (addresses.some((address) => isForbiddenAddress(address.address))) {
        throw new TypeError('Indexer endpoint resolved to a forbidden network address');
      }
      if (
        !approved.allowPrivateNetwork &&
        addresses.some((address) => isPrivateOrLoopbackAddress(address.address))
      ) {
        throw new TypeError('Indexer endpoint resolved to a private network address');
      }
      const resolved = addresses.find((address) =>
        isAllowedAddress(address.address, approved.allowPrivateNetwork),
      );
      if (resolved === undefined) {
        throw new TypeError('Indexer endpoint resolved to a forbidden network address');
      }
      return connect(url, init, resolved);
    },
  };
};

type ApprovedOrigin = { url: URL; allowPrivateNetwork: boolean };

const normalizeOrigin = (value: string): ApprovedOrigin => {
  const url = normalizeEndpoint(value);
  if (url.pathname !== '/') {
    throw new TypeError('Allowed Indexers origins must not contain a path');
  }
  return { url, allowPrivateNetwork: isExplicitPrivateOrigin(url.hostname) };
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

const requestUrl = (input: string | URL | Request): URL => {
  if (input instanceof URL) return new URL(input);
  if (typeof input === 'string') return new URL(input);
  return new URL(input.url);
};

const systemLookup = async (hostname: string): Promise<readonly IndexerResolvedAddress[]> => {
  const normalizedHostname = hostname.replace(/^\[|\]$/gu, '');
  const literalFamily = isIP(normalizedHostname);
  if (literalFamily === 4 || literalFamily === 6) {
    return [{ address: normalizedHostname, family: literalFamily }];
  }
  const answers = await lookupDns(normalizedHostname, { all: true, verbatim: true });
  return answers.flatMap(({ address, family }) =>
    family === 4 || family === 6 ? [{ address, family }] : [],
  );
};

const resolveAddresses = async (
  hostname: string,
  lookup: (hostname: string) => Promise<readonly IndexerResolvedAddress[]>,
): Promise<readonly IndexerResolvedAddress[]> => {
  const addresses = await lookup(hostname);
  if (addresses.length === 0 || addresses.some(({ address, family }) => isIP(address) !== family)) {
    throw new TypeError('Indexer endpoint DNS response is invalid');
  }
  return addresses;
};

const isExplicitPrivateOrigin = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  return (
    isIP(normalized) !== 0 ||
    normalized === 'localhost' ||
    (!normalized.includes('.') && !normalized.includes(':'))
  );
};

const isAllowedAddress = (address: string, allowPrivateNetwork: boolean): boolean =>
  !isForbiddenAddress(address) && (allowPrivateNetwork || !isPrivateOrLoopbackAddress(address));

const isForbiddenAddress = (address: string): boolean => {
  const bytes = addressBytes(address);
  if (bytes === undefined) return true;
  if (bytes.length === 4) {
    const [first = 0, second = 0, third = 0, fourth = 0] = bytes;
    return (
      first === 0 ||
      (first === 169 && second === 254) ||
      first >= 224 ||
      (first === 255 && second === 255 && third === 255 && fourth === 255)
    );
  }
  const [first = 0, second = 0] = bytes;
  return (
    bytes.every((byte) => byte === 0) ||
    (first === 0xfe && (second & 0xc0) === 0x80) ||
    first === 0xff
  );
};

const isPrivateOrLoopbackAddress = (address: string): boolean => {
  const bytes = addressBytes(address);
  if (bytes === undefined) return true;
  if (bytes.length === 4) {
    const [first = 0, second = 0] = bytes;
    return (
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 198 && (second === 18 || second === 19))
    );
  }
  const [first = 0] = bytes;
  return (
    bytes.every((byte, index) => (index === 15 ? byte === 1 : byte === 0)) ||
    (first & 0xfe) === 0xfc
  );
};

const addressBytes = (address: string): readonly number[] | undefined => {
  const normalized = address.toLowerCase();
  if (isIP(normalized) === 4) return normalized.split('.').map(Number);
  if (isIP(normalized) !== 6) return undefined;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(normalized)?.[1];
  if (mapped !== undefined) return mapped.split('.').map(Number);
  const halves = normalized.split('::');
  if (halves.length > 2) return undefined;
  const [leftHalf = '', rightHalf = ''] = halves;
  const left = leftHalf === '' ? [] : leftHalf.split(':');
  const right = halves.length === 1 || rightHalf === '' ? [] : rightHalf.split(':');
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return undefined;
  const groups = [...left, ...Array.from({ length: missing }, () => '0'), ...right];
  if (groups.some((group) => !/^[\da-f]{1,4}$/u.test(group))) return undefined;
  const bytes = groups.flatMap((group) => {
    const value = Number.parseInt(group, 16);
    return [value >>> 8, value & 0xff];
  });
  return bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff
    ? bytes.slice(12)
    : bytes;
};

const pinnedRequest = async (
  url: URL,
  init: RequestInit,
  resolved: IndexerResolvedAddress,
): Promise<Response> => {
  const method = init.method?.toUpperCase() ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    throw new TypeError('Indexer endpoint transport supports only GET and HEAD');
  }
  if (init.body !== undefined && init.body !== null) {
    throw new TypeError('Indexer endpoint transport does not accept request bodies');
  }
  return new Promise<Response>((resolve, reject) => {
    const request = (url.protocol === 'https:' ? requestHttps : requestHttp)(
      url,
      {
        method,
        headers: Object.fromEntries(new Headers(init.headers)),
        lookup: (_hostname, lookupOptions, callback) => {
          if (lookupOptions.all) callback(null, [resolved]);
          else callback(null, resolved.address, resolved.family);
        },
        ...(url.protocol === 'https:' ? { servername: url.hostname } : {}),
      },
      (incoming) => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value))
            value.forEach((item) => {
              headers.append(name, item);
            });
          else if (value !== undefined) headers.set(name, value);
        }
        const hasBody = method !== 'HEAD' && ![204, 205, 304].includes(incoming.statusCode ?? 500);
        resolve(
          new Response(hasBody ? (Readable.toWeb(incoming) as ReadableStream) : null, {
            status: incoming.statusCode ?? 500,
            ...(incoming.statusMessage === undefined ? {} : { statusText: incoming.statusMessage }),
            headers,
          }),
        );
      },
    );
    request.once('error', reject);
    if (init.signal !== undefined && init.signal !== null) {
      const abort = (): void => {
        request.destroy(init.signal?.reason as Error | undefined);
      };
      if (init.signal.aborted) abort();
      else init.signal.addEventListener('abort', abort, { once: true });
    }
    request.end();
  });
};
