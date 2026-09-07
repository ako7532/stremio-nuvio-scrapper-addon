import { describe, expect, it, vi } from 'vitest';

import {
  createWebshareApiClient,
  WebshareTransportError,
} from '../../../src/providers/webshare/webshare-api-client.js';

const xmlResponse = (body: string): Response =>
  new Response(body, { headers: { 'content-type': 'text/xml; charset=UTF-8' } });

describe('Webshare API client', () => {
  it('constructs a bounded authenticated video search POST', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(xmlResponse('<response><status>OK</status><total>0</total></response>'));
    const api = createWebshareApiClient({ fetch: fetchMock });

    await expect(api.search('Sintel 2010', 20, 'private-token')).resolves.toEqual([]);

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://webshare.cz/api/search/');
    expect(url).not.toContain('private-token');
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit', redirect: 'error' });
    expect(init?.headers).not.toHaveProperty('cookie');
    expect(formBody(init)).toBe(
      'what=Sintel+2010&sort=rating&limit=20&offset=0&category=video&wst=private-token',
    );
  });

  it('constructs the documented salt and login requests without putting credentials in URLs', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        xmlResponse('<response><status>OK</status><salt>5pZSV9va</salt></response>'),
      )
      .mockResolvedValueOnce(
        xmlResponse('<response><status>OK</status><token>fixture-token</token></response>'),
      );
    const api = createWebshareApiClient({ fetch: fetchMock });

    await expect(api.getSalt('fixture-user')).resolves.toBe('5pZSV9va');
    await expect(api.login('fixture-user', 'password-digest')).resolves.toBe('fixture-token');

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://webshare.cz/api/salt/');
    expect(formBody(fetchMock.mock.calls[0]?.[1])).toBe('username_or_email=fixture-user');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://webshare.cz/api/login/');
    expect(formBody(fetchMock.mock.calls[1]?.[1])).toBe(
      'username_or_email=fixture-user&password=password-digest&keep_logged_in=0',
    );
  });

  it('keeps the playback token out of the URL and sends it only in the POST body', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        xmlResponse(
          '<response><status>OK</status><link>https://cdn.example.invalid/video</link></response>',
        ),
      );
    const api = createWebshareApiClient({ fetch: fetchMock });

    await expect(api.getPlaybackLink('5m56ZO4cb6', 'private-token')).resolves.toBe(
      'https://cdn.example.invalid/video',
    );

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).not.toContain('private-token');
    expect(formBody(init)).toBe(
      'ident=5m56ZO4cb6&download_type=video_stream&force_https=1&wst=private-token',
    );
    expect(init?.headers).not.toHaveProperty('cookie');
  });

  it('rejects redirects, oversized bodies, and non-XML responses without retrying', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('not xml', { headers: { 'content-type': 'text/plain' } }));
    const api = createWebshareApiClient({ fetch: fetchMock, maximumResponseBytes: 4 });

    const error = await api.search('Sintel', 1, 'private-token').catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(WebshareTransportError);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error' });
  });

  it('distinguishes caller cancellation from timeout', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>(
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
      const api = createWebshareApiClient({ fetch: fetchMock, timeoutMs: 50 });
      const timeout = api.search('Sintel', 1, 'private-token');
      await vi.advanceTimersByTimeAsync(50);
      await expect(timeout).rejects.toMatchObject({ kind: 'timeout' });

      const controller = new AbortController();
      const cancelled = api.search('Sintel', 1, 'private-token', controller.signal);
      controller.abort();
      await expect(cancelled).rejects.toMatchObject({ kind: 'cancelled' });
    } finally {
      vi.useRealTimers();
    }
  });
});

const formBody = (init: RequestInit | undefined): string => {
  if (!(init?.body instanceof URLSearchParams)) {
    throw new TypeError('Expected a URLSearchParams request body');
  }
  return init.body.toString();
};
