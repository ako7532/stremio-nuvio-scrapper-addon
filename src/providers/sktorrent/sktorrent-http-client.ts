import { normalizeSktorrentReadOnlyPageUrl } from './sktorrent-urls.js';

export type SktorrentHttpErrorKind =
  'authentication-failed' | 'cancelled' | 'timeout' | 'unavailable' | 'invalid-response';

export class SktorrentHttpError extends Error {
  override readonly name = 'SktorrentHttpError';
  readonly statusCode?: number;

  constructor(
    readonly kind: SktorrentHttpErrorKind,
    message: string,
    options?: { statusCode?: number; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    if (options?.statusCode !== undefined) {
      this.statusCode = options.statusCode;
    }
  }
}

export type SktorrentHttpClient = {
  getHtml(url: string, signal?: AbortSignal): Promise<string>;
};

export type SktorrentHttpClientOptions = {
  fetch?: typeof fetch;
  timeoutMs?: number;
  maximumResponseBytes?: number;
};

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAXIMUM_RESPONSE_BYTES = 2_000_000;

export const createSktorrentHttpClient = (
  options: SktorrentHttpClientOptions = {},
): SktorrentHttpClient => {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 'timeout');
  const maximumResponseBytes = positiveInteger(
    options.maximumResponseBytes ?? DEFAULT_MAXIMUM_RESPONSE_BYTES,
    'maximum response size',
  );

  return {
    async getHtml(url, signal) {
      const normalizedUrl = normalizeSktorrentReadOnlyPageUrl(url);
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const requestSignal =
        signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);

      try {
        const response = await fetchImplementation(normalizedUrl, {
          method: 'GET',
          headers: { accept: 'text/html,application/xhtml+xml' },
          credentials: 'omit',
          redirect: 'error',
          signal: requestSignal,
        });

        if (!response.ok) {
          throw new SktorrentHttpError(
            'invalid-response',
            `SKTorrent returned HTTP ${String(response.status)}`,
            { statusCode: response.status },
          );
        }

        const contentType = response.headers.get('content-type');
        if (contentType !== null && !contentType.toLowerCase().includes('text/html')) {
          throw new SktorrentHttpError(
            'invalid-response',
            `SKTorrent returned unexpected content type: ${contentType}`,
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
        if (error instanceof SktorrentHttpError) {
          throw error;
        }
        if (signal?.aborted === true) {
          throw new SktorrentHttpError('cancelled', 'SKTorrent request was cancelled', {
            cause: error,
          });
        }
        if (timeoutSignal.aborted) {
          throw new SktorrentHttpError(
            'timeout',
            `SKTorrent request timed out after ${String(timeoutMs)} ms`,
            {
              cause: error,
            },
          );
        }
        throw new SktorrentHttpError('unavailable', 'SKTorrent request failed', { cause: error });
      }
    },
  };
};

const positiveInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`SKTorrent HTTP ${name} must be a positive integer`);
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

const responseTooLarge = (maximumResponseBytes: number): SktorrentHttpError =>
  new SktorrentHttpError(
    'invalid-response',
    `SKTorrent response exceeds ${String(maximumResponseBytes)} bytes`,
  );
