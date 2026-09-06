import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';

import { mediaTypes } from '../domain/media.js';
import { manifest } from './manifest.js';

const streamParamsSchema = z.object({
  type: z.enum(mediaTypes),
  id: z.string().trim().min(1).max(200),
});

export type ServerOptions = {
  logger?: boolean;
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

    return { streams: [] };
  });

  return server;
}
