import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { SearchStreams } from '../application/search-streams.js';
import type { MediaRequest } from '../domain/media.js';
import { mediaTypes } from '../domain/media.js';
import { manifest } from './manifest.js';

const streamParamsSchema = z.object({
  type: z.enum(mediaTypes),
  id: z.string().trim().min(1).max(200),
});

export type ServerOptions = {
  logger?: boolean;
  searchStreams?: SearchStreams;
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

  return server;
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
