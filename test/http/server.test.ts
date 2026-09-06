import { afterEach, describe, expect, it } from 'vitest';

import { buildServer } from '../../src/http/server.js';

const servers: ReturnType<typeof buildServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => server.close()));
});

describe('Stremio HTTP contract', () => {
  it('serves the stream-capable manifest with CORS', async () => {
    const server = buildServer();
    servers.push(server);

    const response = await server.inject({ method: 'GET', url: '/manifest.json' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(response.json()).toMatchObject({
      resources: ['stream'],
      types: ['movie', 'series'],
      idPrefixes: ['tt'],
      behaviorHints: {
        configurable: false,
        configurationRequired: false,
      },
    });
  });

  it('returns a valid empty stream response until providers are connected', async () => {
    const server = buildServer();
    servers.push(server);

    const response = await server.inject({
      method: 'GET',
      url: '/stream/movie/tt0111161.json',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ streams: [] });
  });

  it('rejects unsupported media types', async () => {
    const server = buildServer();
    servers.push(server);

    const response = await server.inject({
      method: 'GET',
      url: '/stream/channel/example.json',
    });

    expect(response.statusCode).toBe(400);
  });
});
