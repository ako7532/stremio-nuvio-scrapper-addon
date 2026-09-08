import { randomBytes } from 'node:crypto';

import Fastify, {
  LogController,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import { z } from 'zod';

import {
  ApplicationError,
  classifyApplicationError,
  type ApplicationErrorKind,
} from '../application/application-error.js';
import type { ConfigurationService } from '../application/configuration-service.js';
import { parseConfigurationId } from '../application/configuration-service.js';
import type { StoredConfiguration } from '../application/configuration-store.js';
import type { ProviderConnectionTester } from '../application/provider-connection-tester.js';
import type { SearchStreams } from '../application/search-streams.js';
import {
  PlaybackResolveError,
  type TorboxPlaybackResolver,
} from '../application/torbox-playback.js';
import type { MediaRequest } from '../domain/media.js';
import { mediaTypes } from '../domain/media.js';
import {
  createFixedWindowRateLimiter,
  type RateLimiter,
} from '../infrastructure/fixed-window-rate-limiter.js';
import { TorboxTransportError } from '../providers/torbox/torbox-api-client.js';
import { PlayTokenError } from '../security/play-token.js';
import { configurePage } from './configure-page.js';
import { manifest } from './manifest.js';
import { torboxDownloadingVideo } from './torbox-downloading-video.js';

const streamParamsSchema = z.object({
  type: z.enum(mediaTypes),
  id: z.string().trim().min(1).max(200),
});
const playParamsSchema = z.object({
  token: z
    .string()
    .min(1)
    .max(4_096)
    .regex(/^[A-Za-z\d._-]+$/u),
});
const configParamsSchema = z.object({ configId: z.string() });
const providerParamsSchema = z.object({
  provider: z.enum(['tmdb', 'sktorrent', 'webshare', 'torbox']),
});
const providerTestSchema = z.strictObject({
  configurationId: z.string().optional(),
  tmdb: z
    .strictObject({ accessToken: z.string().trim().min(1).max(2_048) })
    .nullable()
    .optional(),
  sktorrent: z
    .strictObject({
      username: z.string().trim().min(1).max(320),
      password: z.string().min(1).max(1_024),
    })
    .nullable()
    .optional(),
  webshare: z
    .strictObject({
      username: z.string().trim().min(1).max(320),
      password: z.string().min(1).max(1_024),
    })
    .nullable()
    .optional(),
  torbox: z
    .strictObject({ apiKey: z.string().trim().min(1).max(1_024) })
    .nullable()
    .optional(),
});
const corsRoutes = new Set([
  '/manifest.json',
  '/stream/:type/:id.json',
  '/:configId/manifest.json',
  '/:configId/stream/:type/:id.json',
  '/play/:token',
  '/play/:token/:filename',
  '/download/:token',
  '/download/:token/:filename',
  '/status/torbox-downloading.mp4',
]);

export type ServerOptions = {
  logger?: boolean;
  logLevel?: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  searchStreams?: SearchStreams;
  torboxPlaybackResolver?: TorboxPlaybackResolver;
  configurationService?: ConfigurationService;
  searchStreamsForConfiguration?: (configuration: StoredConfiguration) => SearchStreams | undefined;
  invalidateConfigurationRuntime?: (configId: string) => void;
  providerConnectionTester?: ProviderConnectionTester;
  publicBaseUrl?: string;
  rateLimiters?: Partial<ServerRateLimiters>;
  trustProxy?: boolean;
};

export type ServerRateLimiters = {
  configuration: RateLimiter;
  providerTest: RateLimiter;
  search: RateLimiter;
  playback: RateLimiter;
};

export function buildServer(options: ServerOptions = {}): FastifyInstance {
  const server = Fastify({
    logger: options.logger === true ? { level: options.logLevel ?? 'info' } : false,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 128 * 1_024,
    trustProxy: options.trustProxy ?? false,
    forceCloseConnections: 'idle',
  });
  const rateLimiters = buildRateLimiters(options.rateLimiters);

  server.addHook('onSend', (request, reply, _payload, done) => {
    if (request.routeOptions.url !== undefined && corsRoutes.has(request.routeOptions.url)) {
      void reply.header('access-control-allow-origin', '*');
    }
    void reply.header('x-content-type-options', 'nosniff');
    void reply.header('x-frame-options', 'DENY');
    void reply.header('referrer-policy', 'no-referrer');
    void reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    if (request.url.startsWith('/configure') || request.url.startsWith('/api/')) {
      void reply.header('cache-control', 'no-store');
    }
    done();
  });
  server.addHook('onResponse', (request, reply, done) => {
    server.log.info(
      {
        requestId: request.id,
        method: request.method,
        route: request.routeOptions.url,
        statusCode: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
      },
      'request completed',
    );
    done();
  });
  server.setErrorHandler((error, request, reply) => {
    const classified = classifyApplicationError(error);
    if (classified !== undefined) return sendApplicationError(reply, classified);
    const transportError = httpTransportError(error);
    if (transportError?.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.code(413).send({ error: 'Request body is too large' });
    }
    if (
      transportError?.statusCode !== undefined &&
      transportError.statusCode >= 400 &&
      transportError.statusCode < 500
    ) {
      return reply.code(transportError.statusCode).send({ error: 'Invalid request' });
    }
    server.log.error(
      {
        requestId: request.id,
        method: request.method,
        route: request.routeOptions.url,
        category: 'UnexpectedError',
      },
      'request failed',
    );
    return reply.code(500).send({ error: 'Internal server error' });
  });

  server.get('/health', () => ({ status: 'ok' as const }));
  server.get('/manifest.json', () => manifest);
  server.get('/configure', (_request, reply) => sendConfigurePage(reply));
  server.get('/configure/:configId', (request, reply) => {
    const configId = configuredId(request.params);
    return configId === undefined
      ? reply.code(404).type('text/plain').send('Configuration not found')
      : sendConfigurePage(reply, configId);
  });
  server.post('/api/configurations', async (request, reply) => {
    if (!consumeRateLimit(rateLimiters.configuration, request.ip, reply)) return;
    if (options.configurationService === undefined) return unavailable(reply);
    try {
      return await options.configurationService.create(
        request.body,
        options.publicBaseUrl ?? 'http://127.0.0.1:7000',
      );
    } catch (error) {
      if (error instanceof z.ZodError) {
        return sendApplicationError(
          reply,
          new ApplicationError('InvalidConfiguration', { cause: error }),
        );
      }
      throw error;
    }
  });
  server.get('/api/configurations/:configId', async (request, reply) => {
    const configId = configuredId(request.params);
    if (configId === undefined || options.configurationService === undefined) {
      return reply.code(404).send({ error: 'Configuration not found' });
    }
    const value = await options.configurationService.get(
      configId,
      options.publicBaseUrl ?? 'http://127.0.0.1:7000',
    );
    return value ?? reply.code(404).send({ error: 'Configuration not found' });
  });
  server.put('/api/configurations/:configId', async (request, reply) => {
    if (!consumeRateLimit(rateLimiters.configuration, request.ip, reply)) return;
    const configId = configuredId(request.params);
    if (configId === undefined || options.configurationService === undefined) {
      return reply.code(404).send({ error: 'Configuration not found' });
    }
    try {
      const value = await options.configurationService.update(
        configId,
        request.body,
        options.publicBaseUrl ?? 'http://127.0.0.1:7000',
      );
      if (value === undefined) {
        return await reply.code(404).send({ error: 'Configuration not found' });
      }
      options.invalidateConfigurationRuntime?.(configId);
      return value;
    } catch (error) {
      if (error instanceof z.ZodError) {
        return sendApplicationError(
          reply,
          new ApplicationError('InvalidConfiguration', { cause: error }),
        );
      }
      throw error;
    }
  });
  server.delete('/api/configurations/:configId', async (request, reply) => {
    if (!consumeRateLimit(rateLimiters.configuration, request.ip, reply)) return;
    const configId = configuredId(request.params);
    if (configId === undefined || options.configurationService === undefined) {
      return reply.code(404).send({ error: 'Configuration not found' });
    }
    const revoked = await options.configurationService.revoke(configId);
    if (revoked) options.invalidateConfigurationRuntime?.(configId);
    return revoked
      ? { revoked: true as const }
      : reply.code(404).send({ error: 'Configuration not found' });
  });
  server.post('/api/provider-tests/:provider', async (request, reply) => {
    const provider = providerParamsSchema.safeParse(request.params);
    const body = providerTestSchema.safeParse(request.body);
    if (!provider.success || !body.success || options.providerConnectionTester === undefined) {
      return reply.code(400).send({ error: 'Invalid provider test' });
    }
    if (
      !consumeRateLimit(rateLimiters.providerTest, `${request.ip}:${provider.data.provider}`, reply)
    ) {
      return;
    }
    const stored =
      body.data.configurationId === undefined || options.configurationService === undefined
        ? undefined
        : await options.configurationService.getStored(body.data.configurationId);
    const submitted = body.data[provider.data.provider];
    const credential =
      submitted === null ? undefined : (submitted ?? stored?.credentials[provider.data.provider]);
    if (credential === undefined) {
      return reply.code(400).send({ error: 'Provider credentials are required' });
    }
    try {
      await options.providerConnectionTester(
        provider.data.provider,
        credential,
        stored?.configuration.advanced?.providerTimeoutMs ?? 8_000,
        undefined,
      );
      return { status: 'ok' as const };
    } catch (error) {
      return sendApplicationError(reply, classifyApplicationError(error, 'ProviderUnavailable'));
    }
  });
  server.get('/:configId/manifest.json', async (request, reply) => {
    const stored = await storedConfiguration(request.params, options.configurationService);
    return stored === undefined
      ? reply.code(404).send({ error: 'Configuration not found' })
      : manifest;
  });
  server.get('/:configId/stream/:type/:id.json', async (request, reply) => {
    const parameters = z
      .object({ configId: z.string(), type: z.enum(mediaTypes), id: z.string().min(1).max(200) })
      .safeParse(request.params);
    if (!parameters.success || options.configurationService === undefined) {
      return reply.code(400).send({ error: 'Invalid stream request' });
    }
    const configId = parseConfigurationId(parameters.data.configId);
    const mediaRequest = parseMediaRequest(parameters.data.type, parameters.data.id);
    if (configId === undefined || mediaRequest === undefined) {
      return reply.code(400).send({ error: 'Invalid stream request' });
    }
    if (!consumeRateLimit(rateLimiters.search, `configuration:${configId}`, reply)) return;
    const stored = await options.configurationService.getStored(configId);
    if (stored === undefined) return reply.code(404).send({ error: 'Configuration not found' });
    const searchStreams = options.searchStreamsForConfiguration?.(stored);
    if (searchStreams === undefined) return { streams: [] };
    return { streams: await runSearch(request, searchStreams, mediaRequest) };
  });
  server.get('/stream/:type/:id.json', async (request, reply) => {
    const parsed = streamParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid stream request' });
    }

    const mediaRequest = parseMediaRequest(parsed.data.type, parsed.data.id);
    if (mediaRequest === undefined) {
      return reply.code(400).send({ error: 'Invalid stream request' });
    }
    if (!consumeRateLimit(rateLimiters.search, `address:${request.ip}`, reply)) return;
    if (options.searchStreams === undefined) return { streams: [] };

    const streams = await runSearch(request, options.searchStreams, mediaRequest);
    return { streams };
  });

  server.route({
    method: ['GET', 'HEAD'],
    url: '/status/torbox-downloading.mp4',
    handler(request, reply) {
      void reply
        .type('video/mp4')
        .header('accept-ranges', 'bytes')
        .header('cache-control', 'public, max-age=86400');
      if (request.method === 'HEAD') {
        return reply.header('content-length', String(torboxDownloadingVideo.length)).send();
      }
      const range = parseVideoRange(request.headers.range, torboxDownloadingVideo.length);
      if (range === 'invalid') {
        return reply
          .code(416)
          .header('content-range', `bytes */${String(torboxDownloadingVideo.length)}`)
          .send();
      }
      if (range === undefined) {
        return reply
          .header('content-length', String(torboxDownloadingVideo.length))
          .send(torboxDownloadingVideo);
      }
      const body = torboxDownloadingVideo.subarray(range.start, range.end + 1);
      return reply
        .code(206)
        .header(
          'content-range',
          `bytes ${String(range.start)}-${String(range.end)}/${String(torboxDownloadingVideo.length)}`,
        )
        .header('content-length', String(body.length))
        .send(body);
    },
  });

  const playbackHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = playParamsSchema.safeParse(request.params);
    if (!parsed.success || options.torboxPlaybackResolver === undefined) {
      return reply.code(404).send({ error: 'Playback reference not found' });
    }
    if (!consumeRateLimit(rateLimiters.playback, request.ip, reply)) return;
    const controller = new AbortController();
    request.raw.once('aborted', () => {
      controller.abort();
    });
    try {
      if (request.method === 'HEAD') {
        await options.torboxPlaybackResolver.inspect(parsed.data.token);
        return await reply.code(204).send();
      }
      const playback = await options.torboxPlaybackResolver.resolve(
        parsed.data.token,
        controller.signal,
      );
      return await reply.code(302).header('location', playback.url).send();
    } catch (error) {
      return sendPlaybackError(reply, error);
    }
  };
  server.route({ method: ['GET', 'HEAD'], url: '/play/:token', handler: playbackHandler });
  server.route({
    method: ['GET', 'HEAD'],
    url: '/play/:token/:filename',
    handler: playbackHandler,
  });
  server.route({ method: ['GET', 'HEAD'], url: '/download/:token', handler: playbackHandler });
  server.route({
    method: ['GET', 'HEAD'],
    url: '/download/:token/:filename',
    handler: playbackHandler,
  });

  return server;
}

function sendConfigurePage(reply: FastifyReply, configId?: string) {
  const nonce = randomBytes(18).toString('base64');
  void reply.header(
    'content-security-policy',
    `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
  );
  return reply.type('text/html').send(configurePage(nonce, configId));
}

function buildRateLimiters(overrides: Partial<ServerRateLimiters> = {}): ServerRateLimiters {
  return {
    configuration:
      overrides.configuration ??
      createFixedWindowRateLimiter({ maximumAttempts: 30, windowMs: 60_000 }),
    providerTest:
      overrides.providerTest ??
      createFixedWindowRateLimiter({ maximumAttempts: 10, windowMs: 60_000 }),
    search:
      overrides.search ?? createFixedWindowRateLimiter({ maximumAttempts: 60, windowMs: 60_000 }),
    playback:
      overrides.playback ?? createFixedWindowRateLimiter({ maximumAttempts: 60, windowMs: 60_000 }),
  };
}

function consumeRateLimit(limiter: RateLimiter, key: string, reply: FastifyReply): boolean {
  const decision = limiter.consume(key);
  if (decision.allowed) return true;
  void reply.header('retry-after', String(Math.max(1, Math.ceil(decision.retryAfterMs / 1_000))));
  void reply.code(429).send({ error: 'Too many requests' });
  return false;
}

function configuredId(value: unknown): string | undefined {
  const parsed = configParamsSchema.safeParse(value);
  return parsed.success ? parseConfigurationId(parsed.data.configId) : undefined;
}

async function storedConfiguration(value: unknown, service?: ConfigurationService) {
  const id = configuredId(value);
  return id === undefined || service === undefined ? undefined : service.getStored(id);
}

async function runSearch(
  request: { id: string; raw: { once(event: 'aborted', listener: () => void): unknown } },
  searchStreams: SearchStreams,
  mediaRequest: MediaRequest,
) {
  const controller = new AbortController();
  request.raw.once('aborted', () => {
    controller.abort();
  });
  return searchStreams.search(mediaRequest, {
    signal: controller.signal,
    correlationId: request.id,
  });
}

function unavailable(reply: FastifyReply) {
  return reply.code(503).send({ error: 'Configuration storage is unavailable' });
}

function httpTransportError(error: unknown): { code?: string; statusCode?: number } | undefined {
  return error !== null && typeof error === 'object' ? error : undefined;
}

const applicationErrorResponses: Record<
  ApplicationErrorKind,
  { statusCode: number; message: string }
> = {
  ProviderUnavailable: { statusCode: 503, message: 'Provider is temporarily unavailable' },
  ProviderTimeout: { statusCode: 504, message: 'Provider request timed out' },
  AuthenticationFailed: { statusCode: 502, message: 'Provider authentication failed' },
  RateLimited: { statusCode: 429, message: 'Provider rate limit exceeded' },
  InvalidConfiguration: { statusCode: 400, message: 'Invalid configuration' },
  MediaNotFound: { statusCode: 404, message: 'Media not found' },
  NoMatchingResults: { statusCode: 404, message: 'No matching results' },
  PlaybackResolveFailed: { statusCode: 502, message: 'Playback resolution failed' },
  TorrentUnavailable: { statusCode: 404, message: 'Torrent is unavailable' },
};

function sendApplicationError(reply: FastifyReply, error: ApplicationError) {
  const response = applicationErrorResponses[error.kind];
  if (error.kind === 'RateLimited' && error.retryAfterMs !== undefined) {
    void reply.header('retry-after', String(Math.max(1, Math.ceil(error.retryAfterMs / 1_000))));
  }
  return reply.code(response.statusCode).send({ error: response.message });
}

function sendPlaybackError(reply: FastifyReply, error: unknown) {
  if (error instanceof PlayTokenError) {
    return reply.code(error.kind === 'expired' ? 410 : 400).send({
      error: error.kind === 'expired' ? 'Playback link expired' : 'Invalid playback link',
    });
  }
  if (error instanceof PlaybackResolveError) {
    if (error.kind === 'configuration-not-found' || error.kind === 'invalid-reference') {
      return reply.code(404).send({ error: 'Playback reference not found' });
    }
    return reply.code(503).send({ error: 'Playback is not currently available' });
  }
  if (error instanceof TorboxTransportError) {
    if (error.kind === 'rate-limited') {
      if (error.retryAfterMs !== undefined) {
        void reply.header('retry-after', String(Math.ceil(error.retryAfterMs / 1_000)));
      }
      return reply.code(429).send({ error: 'Playback provider rate limit exceeded' });
    }
    if (error.kind === 'authentication-failed') {
      return reply.code(502).send({ error: 'Playback provider authentication failed' });
    }
  }
  return reply.code(502).send({ error: 'Playback resolution failed' });
}

function parseMediaRequest(
  type: (typeof mediaTypes)[number],
  id: string,
): MediaRequest | undefined {
  if (type === 'movie') {
    return /^(?:tt\d+|tmdb:\d{1,10})$/u.test(id) ? { type, id } : undefined;
  }
  const match = /^((?:tt\d+|tmdb:\d{1,10}|tvdb[:-]\d{1,10}))(?::official)?:(\d+):(\d+)$/u.exec(id);
  if (match === null) return undefined;
  const season = Number(match[2]);
  const episode = Number(match[3]);
  if (
    !Number.isSafeInteger(season) ||
    season < 0 ||
    !Number.isSafeInteger(episode) ||
    episode <= 0
  ) {
    return undefined;
  }
  return { type, id: match[1] ?? '', season, episode };
}

function parseVideoRange(
  value: string | undefined,
  length: number,
): { start: number; end: number } | 'invalid' | undefined {
  if (value === undefined) return undefined;
  const match = /^bytes=(\d+)-(\d*)$/u.exec(value);
  if (match === null) return 'invalid';
  const start = Number(match[1]);
  const requestedEnd = match[2] === '' ? length - 1 : Number(match[2]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    start >= length ||
    requestedEnd < start
  ) {
    return 'invalid';
  }
  return { start, end: Math.min(requestedEnd, length - 1) };
}
