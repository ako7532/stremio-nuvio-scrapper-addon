import { MetadataNotFoundError } from '../metadata/metadata-resolver.js';
import { SktorrentHttpError } from '../providers/sktorrent/sktorrent-http-client.js';
import { SktorrentParserError } from '../providers/sktorrent/sktorrent-types.js';
import { TorboxTransportError } from '../providers/torbox/torbox-api-client.js';
import { WebshareTransportError } from '../providers/webshare/webshare-api-client.js';
import { WebshareApiError } from '../providers/webshare/webshare-xml.js';
import { PlaybackResolveError } from './torbox-playback.js';

export const applicationErrorKinds = [
  'ProviderUnavailable',
  'ProviderTimeout',
  'AuthenticationFailed',
  'RateLimited',
  'InvalidConfiguration',
  'MediaNotFound',
  'NoMatchingResults',
  'PlaybackResolveFailed',
  'TorrentUnavailable',
] as const;

export type ApplicationErrorKind = (typeof applicationErrorKinds)[number];

export class ApplicationError extends Error {
  override readonly name = 'ApplicationError';
  readonly retryAfterMs?: number;

  constructor(
    readonly kind: ApplicationErrorKind,
    options?: { cause?: unknown; retryAfterMs?: number },
  ) {
    super(kind, options?.cause === undefined ? undefined : { cause: options.cause });
    if (options?.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
  }
}

export function classifyApplicationError(
  error: unknown,
  fallbackKind: ApplicationErrorKind,
): ApplicationError;
export function classifyApplicationError(
  error: unknown,
  fallbackKind?: undefined,
): ApplicationError | undefined;
export function classifyApplicationError(
  error: unknown,
  fallbackKind?: ApplicationErrorKind,
): ApplicationError | undefined {
  if (error instanceof ApplicationError) return error;
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return new ApplicationError('ProviderTimeout', { cause: error });
  }
  if (error instanceof MetadataNotFoundError) {
    return new ApplicationError('MediaNotFound', { cause: error });
  }
  if (error instanceof SktorrentHttpError) {
    return new ApplicationError(
      error.kind === 'authentication-failed'
        ? 'AuthenticationFailed'
        : error.kind === 'timeout'
          ? 'ProviderTimeout'
          : 'ProviderUnavailable',
      { cause: error },
    );
  }
  if (error instanceof SktorrentParserError) {
    return new ApplicationError('ProviderUnavailable', { cause: error });
  }
  if (error instanceof WebshareTransportError) {
    return new ApplicationError(
      error.kind === 'timeout' ? 'ProviderTimeout' : 'ProviderUnavailable',
      {
        cause: error,
      },
    );
  }
  if (error instanceof WebshareApiError) {
    return new ApplicationError(
      error.kind === 'authentication' ? 'AuthenticationFailed' : 'ProviderUnavailable',
      { cause: error },
    );
  }
  if (error instanceof TorboxTransportError) {
    const kind: ApplicationErrorKind =
      error.kind === 'authentication-failed'
        ? 'AuthenticationFailed'
        : error.kind === 'rate-limited'
          ? 'RateLimited'
          : error.kind === 'timeout'
            ? 'ProviderTimeout'
            : 'ProviderUnavailable';
    return new ApplicationError(kind, {
      cause: error,
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
    });
  }
  if (error instanceof PlaybackResolveError) {
    return new ApplicationError(
      error.kind === 'torrent-unavailable' ? 'TorrentUnavailable' : 'PlaybackResolveFailed',
      { cause: error },
    );
  }
  return fallbackKind === undefined
    ? undefined
    : new ApplicationError(fallbackKind, { cause: error });
}
