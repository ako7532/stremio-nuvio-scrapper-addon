import { readFile } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import {
  createTorboxApiClient,
  TorboxTransportError,
} from '../../../src/providers/torbox/torbox-api-client.js';

const fixture = async (name: string): Promise<string> =>
  readFile(new URL(`../../fixtures/torbox/${name}`, import.meta.url), 'utf8');

const jsonResponse = (body: string, init: ResponseInit = {}): Response => {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  return new Response(body, {
    ...init,
    headers,
  });
};

describe('TorBox API client', () => {
  it('validates authentication using a Bearer credential that never enters the URL', async () => {
    const successFixture = JSON.parse(await fixture('user-success.json')) as Record<
      string,
      unknown
    >;
    successFixture['error'] = null;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(JSON.stringify(successFixture)));
    const client = createTorboxApiClient({ apiKey: 'server-held-fixture-key', fetch: fetchMock });

    await expect(client.validateAuthentication()).resolves.toBeUndefined();

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(inputUrl(url)).toBe('https://api.torbox.app/v1/api/user/me');
    expect(inputUrl(url)).not.toContain('server-held-fixture-key');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer server-held-fixture-key');
    expect(init).toMatchObject({ credentials: 'omit', redirect: 'error' });
  });

  it('maps an API-level rejected token to an authentication failure', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(await fixture('authentication-failure.json')));
    const client = createTorboxApiClient({ apiKey: 'rejected-fixture-key', fetch: fetchMock });

    await expect(client.validateAuthentication()).rejects.toMatchObject({
      kind: 'authentication-failed',
    });
  });

  it('uses one POST for a mixed cached and uncached hash batch', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(await fixture('cache-mixed.json')));
    const client = createTorboxApiClient({ apiKey: 'fixture-key', fetch: fetchMock });

    await expect(client.checkCached(['A'.repeat(40), 'b'.repeat(40)])).resolves.toEqual([
      { hash: 'a'.repeat(40), status: 'cached' },
      { hash: 'b'.repeat(40), status: 'uncached' },
    ]);

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(inputUrl(url)).toBe('https://api.torbox.app/v1/api/torrents/checkcached');
    expect(init?.method).toBe('POST');
    if (typeof init?.body !== 'string') throw new TypeError('Expected a JSON string body');
    expect(JSON.parse(init.body)).toEqual({ hashes: ['a'.repeat(40), 'b'.repeat(40)] });
  });

  it('parses create, torrent detail, and the TorBox-required credentialed download request', async () => {
    const listFixture = JSON.parse(await fixture('torrent-success.json')) as Record<
      string,
      unknown
    >;
    listFixture['data'] = [listFixture['data']];
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(JSON.stringify(listFixture)))
      .mockResolvedValueOnce(jsonResponse(await fixture('create-success.json')))
      .mockResolvedValueOnce(jsonResponse(await fixture('torrent-success.json')))
      .mockResolvedValueOnce(jsonResponse(await fixture('download-link-success.json')));
    const client = createTorboxApiClient({ apiKey: 'fixture-key', fetch: fetchMock });

    await expect(client.listTorrents()).resolves.toHaveLength(1);
    await expect(client.createTorrent(`magnet:?xt=urn:btih:${'a'.repeat(40)}`)).resolves.toEqual({
      id: 42,
      hash: 'a'.repeat(40),
    });
    const createBody = fetchMock.mock.calls[1]?.[1]?.body;
    expect(createBody).toBeInstanceOf(FormData);
    if (!(createBody instanceof FormData)) throw new TypeError('Expected multipart form data');
    expect(createBody.get('allow_zip')).toBe('false');
    await expect(client.getTorrent(42)).resolves.toMatchObject({
      id: 42,
      downloadFinished: true,
      downloadPresent: true,
      files: { length: 3 },
    });
    await expect(client.requestDownloadLink(42, 1)).resolves.toBe(
      'https://cdn.torbox.app/fixture-video',
    );

    const requestDownloadUrl = inputUrl(fetchMock.mock.calls[3]?.[0]);
    expect(requestDownloadUrl).toContain('torrent_id=42');
    expect(requestDownloadUrl).toContain('file_id=1');
    expect(requestDownloadUrl).toContain('token=fixture-key');
    expect(requestDownloadUrl).toContain('zip_link=false');
  });

  it('accepts missing files while a newly-created torrent is still resolving metadata', async () => {
    const response = {
      success: true,
      detail: 'Torrent list retrieved successfully.',
      data: [
        {
          id: 42,
          hash: 'a'.repeat(40),
          name: 'Resolving metadata',
          download_state: 'metaDL',
          download_finished: false,
          download_present: false,
          files: null,
        },
      ],
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(JSON.stringify(response)));
    const client = createTorboxApiClient({ apiKey: 'fixture-key', fetch: fetchMock });

    await expect(client.listTorrents()).resolves.toEqual([
      expect.objectContaining({ id: 42, files: [], downloadFinished: false }),
    ]);
  });

  it('uploads torrent metadata as a file without placing it in a URL', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(await fixture('create-success.json')));
    const client = createTorboxApiClient({ apiKey: 'fixture-key', fetch: fetchMock });

    await expect(
      client.createTorrentFile?.(Uint8Array.from([100, 49, 58, 97, 101])),
    ).resolves.toEqual({ id: 42, hash: 'a'.repeat(40) });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(inputUrl(url)).toBe('https://api.torbox.app/v1/api/torrents/createtorrent');
    expect(inputUrl(url)).not.toContain('fixture-key');
    expect(init?.body).toBeInstanceOf(FormData);
    if (!(init?.body instanceof FormData)) throw new TypeError('Expected multipart form data');
    expect(init.body.get('file')).toBeInstanceOf(Blob);
    expect(init.body.get('magnet')).toBeNull();
    expect(init.body.get('allow_zip')).toBe('false');
  });

  it('keeps malformed cache responses ambiguous instead of treating them as uncached', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(await fixture('malformed.json')));
    const client = createTorboxApiClient({ apiKey: 'fixture-key', fetch: fetchMock });

    await expect(client.checkCached(['a'.repeat(40)])).rejects.toMatchObject({
      kind: 'invalid-response',
    });
  });

  it('surfaces 429 Retry-After without retrying', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse('{"success":false}', {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '7' },
      }),
    );
    const client = createTorboxApiClient({ apiKey: 'fixture-key', fetch: fetchMock });

    const error = await client.validateAuthentication().catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(TorboxTransportError);
    expect(error).toMatchObject({ kind: 'rate-limited', statusCode: 429, retryAfterMs: 7_000 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('retains only a bounded machine-readable TorBox error code from HTTP failures', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        JSON.stringify({
          success: false,
          error: 'DOWNLOAD_SERVER_ERROR',
          detail: 'private upstream detail',
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      ),
    );
    const client = createTorboxApiClient({ apiKey: 'fixture-key', fetch: fetchMock });

    await expect(
      client.createTorrent(`magnet:?xt=urn:btih:${'a'.repeat(40)}`),
    ).rejects.toMatchObject({
      kind: 'unavailable',
      statusCode: 400,
      errorCode: 'DOWNLOAD_SERVER_ERROR',
      message: 'TorBox returned HTTP 400',
    });
  });

  it('retains a safe error code when TorBox rejects a create request with HTTP 200', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        JSON.stringify({
          success: false,
          error: 'DOWNLOAD_SERVER_ERROR',
          detail: 'There was an error interacting with the download server.',
        }),
      ),
    );
    const client = createTorboxApiClient({ apiKey: 'fixture-key', fetch: fetchMock });

    await expect(
      client.createTorrent(`magnet:?xt=urn:btih:${'a'.repeat(40)}`),
    ).rejects.toMatchObject({
      kind: 'invalid-response',
      errorCode: 'DOWNLOAD_SERVER_ERROR',
    });
  });

  it('bounds response bodies and distinguishes caller cancellation from timeout', async () => {
    const oversizedFetch = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(await fixture('user-success.json'), {
        headers: { 'content-length': '1000' },
      }),
    );
    const boundedClient = createTorboxApiClient({
      apiKey: 'fixture-key',
      fetch: oversizedFetch,
      maximumResponseBytes: 100,
    });
    await expect(boundedClient.validateAuthentication()).rejects.toMatchObject({
      kind: 'invalid-response',
    });

    vi.useFakeTimers();
    const pendingFetch = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => {
              reject(new Error('aborted'));
            },
            { once: true },
          );
        }),
    );
    try {
      const client = createTorboxApiClient({
        apiKey: 'fixture-key',
        fetch: pendingFetch,
        timeoutMs: 50,
      });
      const timeout = client.validateAuthentication();
      await vi.advanceTimersByTimeAsync(50);
      await expect(timeout).rejects.toMatchObject({ kind: 'timeout' });

      const controller = new AbortController();
      const cancelled = client.validateAuthentication(controller.signal);
      controller.abort();
      await expect(cancelled).rejects.toMatchObject({ kind: 'cancelled' });
    } finally {
      vi.useRealTimers();
    }
  });
});

const inputUrl = (input: Parameters<typeof fetch>[0] | undefined): string => {
  if (input === undefined) throw new TypeError('Expected a fetch input');
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
};
