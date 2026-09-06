import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { z } from 'zod';

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
import { TorboxTransportError } from '../providers/torbox/torbox-api-client.js';
import { PlayTokenError } from '../security/play-token.js';
import { configurePage } from './configure-page.js';
import { manifest } from './manifest.js';

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
const providerParamsSchema = z.object({ provider: z.enum(['sktorrent', 'webshare', 'torbox']) });
const providerTestSchema = z.strictObject({
  configurationId: z.string().optional(),
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

export type ServerOptions = {
  logger?: boolean;
  searchStreams?: SearchStreams;
  torboxPlaybackResolver?: TorboxPlaybackResolver;
  configurationService?: ConfigurationService;
  searchStreamsForConfiguration?: (configuration: StoredConfiguration) => SearchStreams | undefined;
  providerConnectionTester?: ProviderConnectionTester;
  publicBaseUrl?: string;
};

export function buildServer(options: ServerOptions = {}): FastifyInstance {
  const server = Fastify({ logger: options.logger ?? false });

  server.addHook('onSend', (_request, reply, _payload, done) => {
    void reply.header('access-control-allow-origin', '*');
    done();
  });

  server.get('/health', () => ({ status: 'ok' as const }));
  server.get('/manifest.json', () => manifest);
  server.get('/configure', (_request, reply) => reply.type('text/html').send(configurePage()));
  server.get('/configure/:configId', (request, reply) => {
    const configId = configuredId(request.params);
    return configId === undefined
      ? reply.code(404).type('text/plain').send('Configuration not found')
      : reply.type('text/html').send(configurePage(configId));
  });
  server.post('/api/configurations', async (request, reply) => {
    if (options.configurationService === undefined) return unavailable(reply);
    try {
      return await options.configurationService.create(
        request.body,
        options.publicBaseUrl ?? 'http://127.0.0.1:7000',
      );
    } catch {
      return reply.code(400).send({ error: 'Invalid configuration' });
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
      return value;
    } catch {
      return reply.code(400).send({ error: 'Invalid configuration' });
    }
  });
  server.delete('/api/configurations/:configId', async (request, reply) => {
    const configId = configuredId(request.params);
    if (configId === undefined || options.configurationService === undefined) {
      return reply.code(404).send({ error: 'Configuration not found' });
    }
    return (await options.configurationService.revoke(configId))
      ? { revoked: true as const }
      : reply.code(404).send({ error: 'Configuration not found' });
  });
  server.post('/api/provider-tests/:provider', async (request, reply) => {
    const provider = providerParamsSchema.safeParse(request.params);
    const body = providerTestSchema.safeParse(request.body);
    if (!provider.success || !body.success || options.providerConnectionTester === undefined) {
      return reply.code(400).send({ error: 'Invalid provider test' });
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
    } catch {
      return reply.code(502).send({ error: 'Provider connection failed' });
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
    if (options.searchStreams === undefined) return { streams: [] };

    const streams = await runSearch(request, options.searchStreams, mediaRequest);
    return { streams };
  });

  server.route({
    method: ['GET', 'HEAD'],
    url: '/play/:token',
    async handler(request, reply) {
      const parsed = playParamsSchema.safeParse(request.params);
      if (!parsed.success || options.torboxPlaybackResolver === undefined) {
        return reply.code(404).send({ error: 'Playback reference not found' });
      }
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
    },
  });

  return server;
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
    return /^tt\d+$/u.test(id) ? { type, id } : undefined;
  }
  const match = /^(tt\d+):(\d+):(\d+)$/u.exec(id);
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
