import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { z } from 'zod';

import type { SearchStreams } from '../application/search-streams.js';
import {
  PlaybackResolveError,
  type TorboxPlaybackResolver,
} from '../application/torbox-playback.js';
import type { MediaRequest } from '../domain/media.js';
import { mediaTypes } from '../domain/media.js';
import { TorboxTransportError } from '../providers/torbox/torbox-api-client.js';
import { PlayTokenError } from '../security/play-token.js';
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

export type ServerOptions = {
  logger?: boolean;
  searchStreams?: SearchStreams;
  torboxPlaybackResolver?: TorboxPlaybackResolver;
};

export function buildServer(options: ServerOptions = {}): FastifyInstance {
  const server = Fastify({ logger: options.logger ?? false });

  server.addHook('onSend', (_request, reply, _payload, done) => {
    void reply.header('access-control-allow-origin', '*');
    done();
  });

  server.get('/health', () => ({ status: 'ok' as const }));
  server.get('/manifest.json', () => manifest);
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

    const controller = new AbortController();
    request.raw.once('aborted', () => {
      controller.abort();
    });
    const streams = await options.searchStreams.search(mediaRequest, {
      signal: controller.signal,
      correlationId: request.id,
    });
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
