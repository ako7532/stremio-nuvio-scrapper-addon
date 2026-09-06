import { readFile } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import { createTmdbClient, TmdbTransportError } from '../../src/metadata/tmdb-client.js';

const fixture = (name: string) =>
  readFile(new URL(`../fixtures/tmdb/${name}`, import.meta.url), 'utf8');

describe('TMDB client', () => {
  it('uses only the official HTTPS origin, bearer header and disabled redirects', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(await fixture('find-movie.json'), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = createTmdbClient({ accessToken: 'sanitized-user-token', fetch: fetchMock });

    await expect(client.findByImdbId({ type: 'movie', id: 'tt0000011' })).resolves.toEqual({
      id: 11,
      title: 'Star Adventure',
      originalTitle: 'Hviezdne dobrodruzstvo',
      year: 1977,
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url instanceof URL ? url.toString() : url).toBe(
      'https://api.themoviedb.org/3/find/tt0000011?external_source=imdb_id&language=en-US',
    );
    expect(init).toMatchObject({
      method: 'GET',
      credentials: 'omit',
      redirect: 'error',
      headers: {
        accept: 'application/json',
        authorization: 'Bearer sanitized-user-token',
      },
    });
    expect(url instanceof URL ? url.toString() : url).not.toContain('sanitized-user-token');
  });

  it('maps rate limits and preserves Retry-After without response details', async () => {
    const client = createTmdbClient({
      accessToken: 'sanitized-user-token',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response('{"status_message":"private"}', {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '7' },
        }),
      ),
    });
    const error = await client
      .findByImdbId({ type: 'movie', id: 'tt0000011' })
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(TmdbTransportError);
    expect(error).toMatchObject({ kind: 'rate-limited', retryAfterMs: 7_000 });
    expect(String(error)).not.toContain('private');
  });

  it('rejects malformed and oversized JSON responses', async () => {
    const malformed = createTmdbClient({
      accessToken: 'sanitized-user-token',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response('{"movie_results":"wrong","tv_results":[]}', {
          headers: { 'content-type': 'application/json' },
        }),
      ),
    });
    await expect(malformed.findByImdbId({ type: 'movie', id: 'tt0000011' })).rejects.toMatchObject({
      kind: 'invalid-response',
    });

    const oversized = createTmdbClient({
      accessToken: 'sanitized-user-token',
      maximumResponseBytes: 4,
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response('12345', { headers: { 'content-type': 'application/json' } }),
        ),
    });
    await expect(oversized.validateAuthentication()).rejects.toMatchObject({
      kind: 'invalid-response',
    });
  });
});
