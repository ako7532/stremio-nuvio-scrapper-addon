import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildServer } from '../../src/http/server.js';
import type { SearchStreams } from '../../src/application/search-streams.js';
import type { TorboxPlaybackResolver } from '../../src/application/torbox-playback.js';

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
        configurable: true,
        configurationRequired: true,
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

  it('parses a standard series identifier and delegates to the search use case', async () => {
    const search = vi
      .fn<SearchStreams['search']>()
      .mockResolvedValue([{ name: 'Test', title: 'Result', infoHash: 'a'.repeat(40) }]);
    const searchStreams: SearchStreams = {
      search,
    };
    const server = buildServer({ searchStreams });
    servers.push(server);

    const response = await server.inject({
      method: 'GET',
      url: '/stream/series/tt1234567:0:4.json',
    });

    expect(response.statusCode).toBe(200);
    expect(search).toHaveBeenCalledOnce();
    const call = search.mock.calls[0];
    expect(call?.[0]).toEqual({ type: 'series', id: 'tt1234567', season: 0, episode: 4 });
    expect(call?.[1].correlationId).toEqual(expect.any(String));
    expect(call?.[1].signal).toBeInstanceOf(AbortSignal);
    expect(response.json()).toEqual({
      streams: [{ name: 'Test', title: 'Result', infoHash: 'a'.repeat(40) }],
    });
  });

  it('rejects a series identifier without season and episode components', async () => {
    const server = buildServer();
    servers.push(server);

    const response = await server.inject({ method: 'GET', url: '/stream/series/tt1234567.json' });

    expect(response.statusCode).toBe(400);
  });

  it('keeps HEAD playback read-only and redirects real GET playback', async () => {
    const inspect = vi.fn<TorboxPlaybackResolver['inspect']>().mockResolvedValue(undefined);
    const resolve = vi.fn<TorboxPlaybackResolver['resolve']>().mockResolvedValue({
      url: 'https://cdn.torbox.app/fixture-video',
      filename: 'Fixture.Show.S01E02.mkv',
    });
    const server = buildServer({ torboxPlaybackResolver: { inspect, resolve } });
    servers.push(server);

    const head = await server.inject({ method: 'HEAD', url: '/play/v1.fixture.token.signature' });
    const get = await server.inject({ method: 'GET', url: '/play/v1.fixture.token.signature' });

    expect(head.statusCode).toBe(204);
    expect(inspect).toHaveBeenCalledOnce();
    expect(resolve).toHaveBeenCalledOnce();
    expect(get.statusCode).toBe(302);
    expect(get.headers.location).toBe('https://cdn.torbox.app/fixture-video');
  });
});
