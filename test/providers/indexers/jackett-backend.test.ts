import { readFile } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import { isEligiblePublicTorrentIndexer } from '../../../src/providers/indexers/indexer-backend.js';
import { createJackettBackend } from '../../../src/providers/indexers/jackett-backend.js';

const fixture = (name: string): Promise<string> =>
  readFile(new URL(`../../fixtures/indexers/${name}`, import.meta.url), 'utf8');

describe('Jackett backend', () => {
  it('discovers the current indexers XML shape and denies non-public or disabled trackers', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response(await fixture('jackett-indexers.xml'), 'application/xml'));
    const backend = createJackettBackend({
      baseUrl: 'http://jackett:9117/',
      apiKey: 'fixture-key',
      fetch: fetchMock,
    });

    const discovered = await backend.discover();

    expect(
      discovered.filter(isEligiblePublicTorrentIndexer).map(({ backendId }) => backendId),
    ).toEqual(['public-fixture']);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    const requested = requestUrl(url);
    expect(requested.pathname).toBe('/api/v2.0/indexers/all/results/torznab/api');
    expect(requested.searchParams.get('t')).toBe('indexers');
    expect(requested.searchParams.get('configured')).toBe('true');
    expect(requested.searchParams.get('apikey')).toBe('fixture-key');
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', credentials: 'omit' });
  });

  it('uses per-indexer caps/search and replaces credential-bearing links with safe references', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(await fixture('caps.xml'), 'application/xml'))
      .mockResolvedValueOnce(response(await fixture('jackett-search.xml'), 'application/rss+xml'));
    const backend = createJackettBackend({
      baseUrl: 'http://jackett:9117/',
      apiKey: 'fixture-key',
      fetch: fetchMock,
    });

    await expect(backend.capabilities('public-fixture')).resolves.toMatchObject({
      modes: { movie: { available: true } },
    });
    const results = await backend.search(
      { backendId: 'public-fixture', name: 'Public Fixture' },
      { mode: 'movie', parameters: { imdbid: 'tt1234567' } },
      'movie',
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.acquisitionReference).toMatch(/^[A-Za-z\d_-]+$/u);
    expect(results[0]?.acquisitionReference).not.toContain('fixture-key');
    const capsUrl = requestUrl(fetchMock.mock.calls[0]?.[0]);
    const searchUrl = requestUrl(fetchMock.mock.calls[1]?.[0]);
    expect(capsUrl.pathname).toBe('/api/v2.0/indexers/public-fixture/results/torznab/api');
    expect(capsUrl.searchParams.get('t')).toBe('caps');
    expect(Object.fromEntries(searchUrl.searchParams)).toMatchObject({
      t: 'movie',
      extended: '1',
      offset: '0',
      imdbid: 'tt1234567',
      apikey: 'fixture-key',
    });
  });

  it('acquires and verifies bounded torrent metainfo only through the Jackett download route', async () => {
    const searchXml = await fixture('jackett-search.xml');
    const encoded = await fixture('../sktorrent/sintel.torrent.b64');
    const torrent = Buffer.from(encoded.trim(), 'base64');
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(searchXml, 'application/rss+xml'))
      .mockResolvedValueOnce(
        new Response(torrent, { headers: { 'content-type': 'application/x-bittorrent' } }),
      );
    const backend = createJackettBackend({
      baseUrl: 'http://jackett:9117/',
      apiKey: 'fixture-key',
      fetch: fetchMock,
    });
    const [candidate] = await backend.search(
      { backendId: 'public-fixture', name: 'Public Fixture' },
      { mode: 'search', parameters: { q: 'Fixture Movie' } },
      'movie',
    );

    const acquired = await backend.acquire(
      'public-fixture',
      candidate?.acquisitionReference ?? '',
      '9ca7792139b16d7f68132ed46ce79f649a72b45b',
    );

    expect(acquired).toMatchObject({
      kind: 'file',
      infoHash: '9ca7792139b16d7f68132ed46ce79f649a72b45b',
    });
    const acquisitionUrl = requestUrl(fetchMock.mock.calls[1]?.[0]);
    expect(acquisitionUrl.pathname).toBe('/dl/public-fixture');
    expect(acquisitionUrl.searchParams.get('path')).toBe('opaque-backend-reference');
    expect(acquisitionUrl.searchParams.get('file')).toBe('Fixture.Movie.torrent');
    expect(acquisitionUrl.searchParams.get('jackett_apikey')).toBe('fixture-key');
  });

  it('accepts only a supported magnet redirect and verifies its identity', async () => {
    const magnet = 'magnet:?xt=urn:btih:9ca7792139b16d7f68132ed46ce79f649a72b45b';
    const backend = createJackettBackend({
      baseUrl: 'http://jackett:9117/',
      apiKey: 'fixture-key',
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status: 302, headers: { location: magnet } })),
    });
    const reference = Buffer.from(
      JSON.stringify({ path: 'opaque-backend-reference', file: 'Fixture.torrent' }),
    ).toString('base64url');

    await expect(
      backend.acquire('public-fixture', reference, '9ca7792139b16d7f68132ed46ce79f649a72b45b'),
    ).resolves.toEqual({
      kind: 'magnet',
      infoHash: '9ca7792139b16d7f68132ed46ce79f649a72b45b',
      magnetUri: magnet,
    });

    const unsafeBackend = createJackettBackend({
      baseUrl: 'http://jackett:9117/',
      apiKey: 'fixture-key',
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(null, { status: 302, headers: { location: 'https://outside.example/' } }),
        ),
    });
    await expect(unsafeBackend.acquire('public-fixture', reference)).rejects.toMatchObject({
      kind: 'invalid-response',
    });
  });

  it('maps authentication and rate limiting without including credentials in errors', async () => {
    const authenticationBackend = createJackettBackend({
      baseUrl: 'http://jackett:9117/',
      apiKey: 'fixture-key',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 401 })),
    });
    await expect(authenticationBackend.discover()).rejects.toMatchObject({
      kind: 'authentication-failed',
      statusCode: 401,
    });

    const rateLimitedBackend = createJackettBackend({
      baseUrl: 'http://jackett:9117/',
      apiKey: 'fixture-key',
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status: 429, headers: { 'retry-after': '3' } })),
    });
    await expect(rateLimitedBackend.discover()).rejects.toMatchObject({
      kind: 'rate-limited',
      retryAfterMs: 3_000,
    });
  });
});

const response = (body: string, contentType: string): Response =>
  new Response(body, { status: 200, headers: { 'content-type': contentType } });

const requestUrl = (value: Parameters<typeof fetch>[0] | undefined): URL => {
  if (value instanceof URL) return value;
  if (value instanceof Request) return new URL(value.url);
  if (typeof value === 'string') return new URL(value);
  throw new TypeError('Expected a request URL');
};
