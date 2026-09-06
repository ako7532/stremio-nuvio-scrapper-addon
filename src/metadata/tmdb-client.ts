import { z } from 'zod';

import type { MediaRequest } from '../domain/media.js';

export type TmdbMediaRecord = {
  id: number;
  originalTitle: string;
  title: string;
  year?: number;
};

export type TmdbAlternativeTitle = { title: string; country?: string };

export type TmdbClient = {
  validateAuthentication(signal?: AbortSignal): Promise<void>;
  findByImdbId(request: MediaRequest, signal?: AbortSignal): Promise<TmdbMediaRecord | undefined>;
  getLocalizedTitle(
    type: MediaRequest['type'],
    id: number,
    language: string,
    signal?: AbortSignal,
  ): Promise<string>;
  getAlternativeTitles(
    type: MediaRequest['type'],
    id: number,
    signal?: AbortSignal,
  ): Promise<readonly TmdbAlternativeTitle[]>;
};

export type TmdbTransportErrorKind =
  | 'authentication-failed'
  | 'cancelled'
  | 'timeout'
  | 'rate-limited'
  | 'not-found'
  | 'unavailable'
  | 'invalid-response';

export class TmdbTransportError extends Error {
  override readonly name = 'TmdbTransportError';
  readonly statusCode?: number;
  readonly retryAfterMs?: number;

  constructor(
    readonly kind: TmdbTransportErrorKind,
    message: string,
    options?: { statusCode?: number; retryAfterMs?: number; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    if (options?.statusCode !== undefined) this.statusCode = options.statusCode;
    if (options?.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
  }
}

export type TmdbClientOptions = {
  accessToken: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maximumResponseBytes?: number;
};

const movieSchema = z.looseObject({
  id: z.number().int().positive(),
  title: z.string().trim().min(1),
  original_title: z.string().trim().min(1),
  release_date: z.string().optional(),
});
const seriesSchema = z.looseObject({
  id: z.number().int().positive(),
  name: z.string().trim().min(1),
  original_name: z.string().trim().min(1),
  first_air_date: z.string().optional(),
});
const findSchema = z.looseObject({
  movie_results: z.array(movieSchema),
  tv_results: z.array(seriesSchema),
});
const movieDetailsSchema = z.looseObject({ title: z.string().trim().min(1) });
const seriesDetailsSchema = z.looseObject({ name: z.string().trim().min(1) });
const movieAlternativeTitlesSchema = z.looseObject({
  titles: z.array(
    z.looseObject({
      title: z.string().trim().min(1),
      iso_3166_1: z.string().trim().length(2).optional(),
    }),
  ),
});
const seriesAlternativeTitlesSchema = z.looseObject({
  results: z.array(
    z.looseObject({
      title: z.string().trim().min(1),
      iso_3166_1: z.string().trim().length(2).optional(),
    }),
  ),
});

const ORIGIN = 'https://api.themoviedb.org';
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAXIMUM_RESPONSE_BYTES = 1_000_000;

export const createTmdbClient = (options: TmdbClientOptions): TmdbClient => {
  const accessToken = requiredToken(options.accessToken);
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 'timeout');
  const maximumResponseBytes = positiveInteger(
    options.maximumResponseBytes ?? DEFAULT_MAXIMUM_RESPONSE_BYTES,
    'maximum response size',
  );

  const request = async (path: string, signal?: AbortSignal): Promise<unknown> => {
    const url = allowedUrl(path);
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const requestSignal =
      signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
    try {
      const response = await fetchImplementation(url, {
        method: 'GET',
        headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` },
        credentials: 'omit',
        redirect: 'error',
        signal: requestSignal,
      });
      if (!response.ok) throw httpError(response);
      const contentType = response.headers.get('content-type')?.toLowerCase();
      if (contentType !== undefined && !contentType.includes('json')) {
        throw invalidResponse('TMDB returned an unexpected content type');
      }
      const declaredLength = response.headers.get('content-length');
      if (
        declaredLength !== null &&
        /^\d+$/u.test(declaredLength) &&
        Number(declaredLength) > maximumResponseBytes
      ) {
        throw invalidResponse('TMDB response is too large');
      }
      const body = await response.arrayBuffer();
      if (body.byteLength > maximumResponseBytes)
        throw invalidResponse('TMDB response is too large');
      try {
        return JSON.parse(new TextDecoder().decode(body));
      } catch (error) {
        throw invalidResponse('TMDB returned invalid JSON', error);
      }
    } catch (error) {
      if (error instanceof TmdbTransportError) throw error;
      if (signal?.aborted === true) {
        throw new TmdbTransportError('cancelled', 'TMDB request was cancelled', { cause: error });
      }
      if (timeoutSignal.aborted) {
        throw new TmdbTransportError('timeout', 'TMDB request timed out', { cause: error });
      }
      throw new TmdbTransportError('unavailable', 'TMDB request failed', { cause: error });
    }
  };

  return {
    async validateAuthentication(signal) {
      parse(
        z.looseObject({ success: z.literal(true) }),
        await request('/3/authentication', signal),
      );
    },
    async findByImdbId(media, signal) {
      const response = parse(
        findSchema,
        await request(
          `/3/find/${encodeURIComponent(media.id)}?external_source=imdb_id&language=en-US`,
          signal,
        ),
      );
      if (media.type === 'movie') {
        const result = response.movie_results[0];
        return result === undefined
          ? undefined
          : {
              id: result.id,
              title: result.title,
              originalTitle: result.original_title,
              ...yearFrom(result.release_date),
            };
      }
      const result = response.tv_results[0];
      return result === undefined
        ? undefined
        : {
            id: result.id,
            title: result.name,
            originalTitle: result.original_name,
            ...yearFrom(result.first_air_date),
          };
    },
    async getLocalizedTitle(type, id, language, signal) {
      const path = `/3/${type === 'movie' ? 'movie' : 'tv'}/${String(positiveInteger(id, 'media ID'))}?language=${encodeURIComponent(normalizeLanguage(language))}`;
      const response = await request(path, signal);
      return type === 'movie'
        ? parse(movieDetailsSchema, response).title
        : parse(seriesDetailsSchema, response).name;
    },
    async getAlternativeTitles(type, id, signal) {
      const path = `/3/${type === 'movie' ? 'movie' : 'tv'}/${String(positiveInteger(id, 'media ID'))}/alternative_titles`;
      const response = await request(path, signal);
      const values =
        type === 'movie'
          ? parse(movieAlternativeTitlesSchema, response).titles
          : parse(seriesAlternativeTitlesSchema, response).results;
      return values.map((value) => ({
        title: value.title,
        ...(value.iso_3166_1 === undefined ? {} : { country: value.iso_3166_1.toUpperCase() }),
      }));
    },
  };
};

const allowedUrl = (path: string): URL => {
  if (
    !/^\/3\/(?:authentication|find\/tt\d+|(?:movie|tv)\/\d+(?:\/alternative_titles)?)(?:\?[^#]*)?$/u.test(
      path,
    )
  ) {
    throw new TypeError('TMDB API path is not allowed');
  }
  const url = new URL(path, ORIGIN);
  if (url.origin !== ORIGIN || url.protocol !== 'https:')
    throw new TypeError('TMDB API origin is not allowed');
  return url;
};

const parse = <Schema extends z.ZodType>(schema: Schema, value: unknown): z.output<Schema> => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw invalidResponse('TMDB returned an invalid response');
  return parsed.data;
};

const httpError = (response: Response): TmdbTransportError => {
  if (response.status === 401 || response.status === 403) {
    return new TmdbTransportError('authentication-failed', 'TMDB authentication failed', {
      statusCode: response.status,
    });
  }
  if (response.status === 404)
    return new TmdbTransportError('not-found', 'TMDB media was not found', { statusCode: 404 });
  if (response.status === 429) {
    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
    return new TmdbTransportError('rate-limited', 'TMDB rate limit exceeded', {
      statusCode: 429,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
  }
  return new TmdbTransportError('unavailable', `TMDB returned HTTP ${String(response.status)}`, {
    statusCode: response.status,
  });
};

const parseRetryAfter = (value: string | null, now = Date.now()): number | undefined => {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
};

const yearFrom = (value: string | undefined): { year?: number } => {
  const match = /^(\d{4})-/u.exec(value ?? '');
  return match?.[1] === undefined ? {} : { year: Number(match[1]) };
};

const normalizeLanguage = (value: string): string => {
  const normalized = value.trim();
  if (!/^[a-z]{2}(?:-[A-Z]{2})?$/u.test(normalized)) throw new TypeError('Invalid TMDB language');
  return normalized;
};

const requiredToken = (value: string): string => {
  const normalized = value.trim();
  if (normalized.length === 0 || /[\r\n]/u.test(normalized))
    throw new TypeError('TMDB access token is required');
  return normalized;
};

const positiveInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new RangeError(`TMDB ${name} must be a positive integer`);
  return value;
};

const invalidResponse = (message: string, cause?: unknown): TmdbTransportError =>
  new TmdbTransportError('invalid-response', message, cause === undefined ? undefined : { cause });
