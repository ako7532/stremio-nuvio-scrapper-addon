import { readFile } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import {
  createSktorrentHttpClient,
  SktorrentHttpError,
} from '../../../src/providers/sktorrent/sktorrent-http-client.js';
import { parseSktorrentListing } from '../../../src/providers/sktorrent/sktorrent-listing-parser.js';
import { buildSktorrentListingUrl } from '../../../src/providers/sktorrent/sktorrent-urls.js';

const fixture = await readFile(
  new URL('../../fixtures/sktorrent/listing.html', import.meta.url),
  'utf8',
);

describe('SKTorrent HTTP client', () => {
  it('fetches fixture HTML with read-only request settings and keeps parsing separate', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(fixture, { headers: { 'content-type': 'text/html; charset=utf-8' } }),
      );
    const client = createSktorrentHttpClient({ fetch: fetchMock });
    const url = buildSktorrentListingUrl('Sample serial');

    const html = await client.getHtml(url);

    expect(parseSktorrentListing(html)).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [requestedUrl, requestInit] = fetchMock.mock.calls[0] ?? [];
    expect(requestedUrl).toBe(url);
    expect(requestInit).toMatchObject({
      method: 'GET',
      headers: { accept: 'text/html,application/xhtml+xml' },
      credentials: 'omit',
      redirect: 'error',
    });
    expect(requestInit?.signal).toBeInstanceOf(AbortSignal);
  });

  it('refuses download and off-origin URLs before making a request', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const client = createSktorrentHttpClient({ fetch: fetchMock });

    await expect(
      client.getHtml(
        'https://sktorrent.eu/torrent/download.php?id=1111111111111111111111111111111111111111',
      ),
    ).rejects.toThrow('Unexpected SKTorrent read-only page URL');
    await expect(
      client.getHtml('https://example.com/torrent/torrents_v2.php?search=Sample'),
    ).rejects.toThrow('Unexpected SKTorrent URL');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps HTTP failures without retrying', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('Unavailable', { status: 503 }));
    const client = createSktorrentHttpClient({ fetch: fetchMock });

    const error = await client
      .getHtml(buildSktorrentListingUrl('Sample'))
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(SktorrentHttpError);
    expect(error).toMatchObject({ kind: 'invalid-response', statusCode: 503 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('rejects oversized responses even without a content-length header', async () => {
    const client = createSktorrentHttpClient({
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response('12345')),
      maximumResponseBytes: 4,
    });

    await expect(client.getHtml(buildSktorrentListingUrl('Sample'))).rejects.toMatchObject({
      kind: 'invalid-response',
    });
  });

  it('distinguishes caller cancellation from provider timeout', async () => {
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
      const client = createSktorrentHttpClient({ fetch: fetchMock, timeoutMs: 50 });
      const timedOut = client.getHtml(buildSktorrentListingUrl('Timeout'));
      await vi.advanceTimersByTimeAsync(50);
      await expect(timedOut).rejects.toMatchObject({ kind: 'timeout' });

      const controller = new AbortController();
      const cancelled = client.getHtml(buildSktorrentListingUrl('Cancelled'), controller.signal);
      controller.abort();
      await expect(cancelled).rejects.toMatchObject({ kind: 'cancelled' });
    } finally {
      vi.useRealTimers();
    }
  });
});
