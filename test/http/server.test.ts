import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildServer } from '../../src/http/server.js';
import { ApplicationError } from '../../src/application/application-error.js';
import type { SearchStreams } from '../../src/application/search-streams.js';
import type { TorboxPlaybackResolver } from '../../src/application/torbox-playback.js';
import { createFixedWindowRateLimiter } from '../../src/infrastructure/fixed-window-rate-limiter.js';

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
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.json()).toMatchObject({
      resources: ['stream'],
      types: ['movie', 'series'],
      idPrefixes: ['tt', 'tmdb:', 'tvdb:', 'tvdb-'],
      behaviorHints: {
        configurable: true,
        configurationRequired: true,
      },
    });
  });

  it('rate limits stream requests using the client address', async () => {
    const server = buildServer({
      searchStreams: { search: vi.fn().mockResolvedValue([]) },
      rateLimiters: {
        search: createFixedWindowRateLimiter({ maximumAttempts: 1, windowMs: 5_000 }),
      },
    });
    servers.push(server);

    const first = await server.inject({ method: 'GET', url: '/stream/movie/tt0111161.json' });
    const limited = await server.inject({ method: 'GET', url: '/stream/movie/tt0111161.json' });

    expect(first.statusCode).toBe(200);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('5');
    expect(limited.json()).toEqual({ error: 'Too many requests' });
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

  it.each([
    ['tmdb:46612:1:1', 'tmdb:46612'],
    ['tvdb:83757:1:1', 'tvdb:83757'],
    ['tvdb:83757:official:1:1', 'tvdb:83757'],
    ['tvdb-83757:1:1', 'tvdb-83757'],
  ])('parses external series identifier %s', async (id, expectedId) => {
    const search = vi.fn<SearchStreams['search']>().mockResolvedValue([]);
    const server = buildServer({ searchStreams: { search } });
    servers.push(server);

    const response = await server.inject({ method: 'GET', url: `/stream/series/${id}.json` });

    expect(response.statusCode).toBe(200);
    expect(search.mock.calls[0]?.[0]).toEqual({
      type: 'series',
      id: expectedId,
      season: 1,
      episode: 1,
    });
  });

  it('rejects a series identifier without season and episode components', async () => {
    const server = buildServer();
    servers.push(server);

    const response = await server.inject({ method: 'GET', url: '/stream/series/tt1234567.json' });

    expect(response.statusCode).toBe(400);
  });

  it('returns sanitized application errors and provider backoff', async () => {
    const searchStreams: SearchStreams = {
      search: vi.fn().mockRejectedValue(
        new ApplicationError('RateLimited', {
          cause: new Error('secret provider response'),
          retryAfterMs: 2_500,
        }),
      ),
    };
    const server = buildServer({ searchStreams });
    servers.push(server);

    const response = await server.inject({ method: 'GET', url: '/stream/movie/tt0111161.json' });

    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBe('3');
    expect(response.json()).toEqual({ error: 'Provider rate limit exceeded' });
    expect(response.body).not.toContain('secret provider response');
  });

  it('does not expose unexpected error messages', async () => {
    const searchStreams: SearchStreams = {
      search: vi.fn().mockRejectedValue(new Error('secret internal failure')),
    };
    const server = buildServer({ searchStreams });
    servers.push(server);

    const response = await server.inject({ method: 'GET', url: '/stream/movie/tt0111161.json' });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: 'Internal server error' });
    expect(response.body).not.toContain('secret internal failure');
  });

  it('keeps HEAD playback read-only and redirects real GET playback', async () => {
    const inspect = vi.fn<TorboxPlaybackResolver['inspect']>().mockResolvedValue(undefined);
    const resolve = vi.fn<TorboxPlaybackResolver['resolve']>().mockResolvedValue({
      url: 'https://cdn.torbox.app/fixture-video',
      filename: 'Fixture.Show.S01E02.mkv',
    });
    const server = buildServer({ torboxPlaybackResolver: { inspect, resolve } });
    servers.push(server);

    const head = await server.inject({
      method: 'HEAD',
      url: '/play/v1.fixture.token.signature/Fixture.Show.S01E02.mkv',
    });
    const legacyHead = await server.inject({
      method: 'HEAD',
      url: '/play/v1.fixture.token.signature',
    });
    const get = await server.inject({
      method: 'GET',
      url: '/play/v1.fixture.token.signature/Fixture.Show.S01E02.mkv',
    });
    const downloadHead = await server.inject({
      method: 'HEAD',
      url: '/download/v1.fixture.token.signature/Fixture.Show.S01E02.mkv',
    });

    expect(head.statusCode).toBe(204);
    expect(legacyHead.statusCode).toBe(204);
    expect(downloadHead.statusCode).toBe(204);
    expect(inspect).toHaveBeenCalledTimes(3);
    expect(inspect).toHaveBeenNthCalledWith(1, 'v1.fixture.token.signature');
    expect(inspect).toHaveBeenNthCalledWith(2, 'v1.fixture.token.signature');
    expect(inspect).toHaveBeenNthCalledWith(3, 'v1.fixture.token.signature');
    expect(resolve).toHaveBeenCalledOnce();
    expect(get.statusCode).toBe(302);
    expect(get.headers.location).toBe('https://cdn.torbox.app/fixture-video');
  });

  it('serves the TorBox downloading video with byte-range support', async () => {
    const server = buildServer();
    servers.push(server);

    const full = await server.inject({
      method: 'HEAD',
      url: '/status/torbox-downloading.mp4',
    });
    const partial = await server.inject({
      method: 'GET',
      url: '/status/torbox-downloading.mp4',
      headers: { range: 'bytes=0-99' },
    });

    expect(full.statusCode).toBe(200);
    expect(full.headers['content-type']).toContain('video/mp4');
    expect(Number(full.headers['content-length'])).toBeGreaterThan(10_000);
    expect(partial.statusCode).toBe(206);
    expect(partial.headers['content-range']).toMatch(/^bytes 0-99\/\d+$/u);
    expect(partial.rawPayload).toHaveLength(100);
  });
});
