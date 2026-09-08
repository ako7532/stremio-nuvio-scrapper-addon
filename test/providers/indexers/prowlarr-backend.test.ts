import { readFile } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import { isEligiblePublicTorrentIndexer } from '../../../src/providers/indexers/indexer-backend.js';
import { createProwlarrBackend } from '../../../src/providers/indexers/prowlarr-backend.js';

const fixture = (name: string): Promise<string> =>
  readFile(new URL(`../../fixtures/indexers/${name}`, import.meta.url), 'utf8');

describe('Prowlarr backend', () => {
  it('discovers typed indexers and allows only enabled public torrent search', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response(await fixture('prowlarr-indexers.json'), 'application/json'));
    const backend = createProwlarrBackend({
      baseUrl: 'http://prowlarr:9696/',
      apiKey: 'fixture-key',
      fetch: fetchMock,
    });

    const discovered = await backend.discover();

    expect(
      discovered.filter(isEligiblePublicTorrentIndexer).map(({ backendId }) => backendId),
    ).toEqual(['1']);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(requestUrl(url).toString()).toBe('http://prowlarr:9696/api/v1/indexer');
    expect(requestUrl(url).toString()).not.toContain('fixture-key');
    expect(new Headers(init?.headers).get('X-Api-Key')).toBe('fixture-key');
    expect(init).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit' });
  });

  it('uses per-indexer caps and bounded capability-aware search parameters', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(await fixture('caps.xml'), 'application/xml'))
      .mockResolvedValueOnce(response(await fixture('search.xml'), 'application/rss+xml'));
    const backend = createProwlarrBackend({
      baseUrl: 'https://prowlarr.example/base/',
      apiKey: 'fixture-key',
      fetch: fetchMock,
    });

    await expect(backend.capabilities('1')).resolves.toMatchObject({
      modes: { movie: { available: true } },
    });
    await expect(
      backend.search(
        { backendId: '1', name: 'Public Fixture' },
        { mode: 'movie', parameters: { imdbid: 'tt1234567' } },
        'movie',
      ),
    ).resolves.toHaveLength(2);

    expect(requestUrl(fetchMock.mock.calls[0]?.[0]).toString()).toBe(
      'https://prowlarr.example/base/api/v1/indexer/1/newznab?t=caps',
    );
    const searchUrl = requestUrl(fetchMock.mock.calls[1]?.[0]);
    expect(searchUrl.pathname).toBe('/base/api/v1/indexer/1/newznab');
    expect(Object.fromEntries(searchUrl.searchParams)).toEqual({
      t: 'movie',
      extended: '1',
      limit: '100',
      offset: '0',
      imdbid: 'tt1234567',
    });
  });

  it('does not follow redirects or leak the API key into request URLs', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 302 }));
    const backend = createProwlarrBackend({
      baseUrl: 'https://prowlarr.example/',
      apiKey: 'fixture-key',
      fetch: fetchMock,
    });

    await expect(backend.discover()).rejects.toMatchObject({
      kind: 'unavailable',
      statusCode: 302,
    });
    expect(requestUrl(fetchMock.mock.calls[0]?.[0]).toString()).not.toContain('fixture-key');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error' });
  });

  it('acquires bounded metainfo through the backend and verifies its exact identity', async () => {
    const encoded = await fixture('../sktorrent/sintel.torrent.b64');
    const torrent = Buffer.from(encoded.trim(), 'base64');
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(torrent, {
        status: 200,
        headers: { 'content-type': 'application/x-bittorrent' },
      }),
    );
    const backend = createProwlarrBackend({
      baseUrl: 'https://prowlarr.example/',
      apiKey: 'fixture-key',
      fetch: fetchMock,
    });

    const acquired = await backend.acquire(
      '1',
      'https://tracker.example/download?id=fixture',
      '9ca7792139b16d7f68132ed46ce79f649a72b45b',
    );

    expect(acquired).toMatchObject({
      kind: 'file',
      infoHash: '9ca7792139b16d7f68132ed46ce79f649a72b45b',
      magnetUri: 'magnet:?xt=urn:btih:9ca7792139b16d7f68132ed46ce79f649a72b45b',
    });
    expect(acquired.kind).toBe('file');
    if (acquired.kind === 'file') expect(acquired.torrentFile).toEqual(new Uint8Array(torrent));
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(requestUrl(url).origin).toBe('https://prowlarr.example');
    expect(requestUrl(url).pathname).toBe('/api/v1/indexer/1/download');
    expect(requestUrl(url).searchParams.get('link')).toBe(
      'https://tracker.example/download?id=fixture',
    );
    expect(requestUrl(url).toString()).not.toContain('fixture-key');
    expect(init).toMatchObject({ redirect: 'error', credentials: 'omit' });
  });

  it('rejects acquisition identity mismatch, redirects, and oversized files', async () => {
    const encoded = await fixture('../sktorrent/sintel.torrent.b64');
    const torrent = Buffer.from(encoded.trim(), 'base64');
    const mismatchBackend = createProwlarrBackend({
      baseUrl: 'https://prowlarr.example/',
      apiKey: 'fixture-key',
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(torrent, { headers: { 'content-type': 'application/x-bittorrent' } }),
        ),
    });
    await expect(
      mismatchBackend.acquire('1', 'fixture-reference', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    ).rejects.toMatchObject({ kind: 'invalid-response' });

    const redirectBackend = createProwlarrBackend({
      baseUrl: 'https://prowlarr.example/',
      apiKey: 'fixture-key',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 302 })),
    });
    await expect(redirectBackend.acquire('1', 'fixture-reference')).rejects.toMatchObject({
      kind: 'unavailable',
      statusCode: 302,
    });

    const oversizedBackend = createProwlarrBackend({
      baseUrl: 'https://prowlarr.example/',
      apiKey: 'fixture-key',
      maximumTorrentBytes: 10,
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(torrent, { headers: { 'content-type': 'application/x-bittorrent' } }),
        ),
    });
    await expect(oversizedBackend.acquire('1', 'fixture-reference')).rejects.toMatchObject({
      kind: 'invalid-response',
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
