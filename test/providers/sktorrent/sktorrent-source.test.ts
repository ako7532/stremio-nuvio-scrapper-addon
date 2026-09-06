import { readFile } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import { createSktorrentSource } from '../../../src/providers/sktorrent/sktorrent-source.js';

const listingFixture = await readFile(
  new URL('../../fixtures/sktorrent/listing.html', import.meta.url),
  'utf8',
);
const detailFixture = await readFile(
  new URL('../../fixtures/sktorrent/detail.html', import.meta.url),
  'utf8',
);
const torrentFixture = Buffer.from(
  (
    await readFile(new URL('../../fixtures/sktorrent/sintel.torrent.b64', import.meta.url), 'utf8')
  ).trim(),
  'base64',
);

describe('SKTorrent source', () => {
  it('keeps public HTML requests separate and authenticates torrent downloads lazily', async () => {
    const fetchMock = vi.fn<typeof fetch>((input, init) => {
      const url = new URL(requestUrl(input));
      if (url.pathname.endsWith('/torrents_v2.php')) {
        return Promise.resolve(htmlResponse(listingFixture));
      }
      if (url.pathname.endsWith('/details.php')) {
        return Promise.resolve(htmlResponse(detailFixture));
      }
      if (url.pathname.endsWith('/login.php')) {
        expect(init?.body).toBeInstanceOf(URLSearchParams);
        expect(init?.body instanceof URLSearchParams ? init.body.toString() : undefined).toBe(
          'uid=test-user&pwd=test-password',
        );
        return Promise.resolve(
          new Response('logged in', {
            headers: { 'set-cookie': 'uid=session-value; Path=/' },
          }),
        );
      }
      if (url.pathname === '/torrent/') {
        expect(new Headers(init?.headers).get('cookie')).toBe('uid=session-value');
        return Promise.resolve(htmlResponse('<a href="logout.php">Logout</a>'));
      }
      if (url.pathname.endsWith('/download.php')) {
        expect(new Headers(init?.headers).get('cookie')).toBe('uid=session-value');
        return Promise.resolve(
          new Response(torrentFixture, {
            headers: { 'content-type': 'application/x-bittorrent' },
          }),
        );
      }
      throw new Error(`Unexpected test URL: ${url.pathname}`);
    });
    const source = createSktorrentSource(
      { username: 'test-user', password: 'test-password' },
      { fetch: fetchMock },
    );

    const listings = await source.search('Sample');
    const listing = listings[0];
    if (listing === undefined) {
      throw new Error('Expected a listing result');
    }
    const detail = await source.getDetail(listing);
    const firstDownload = await source.downloadTorrent(detail);
    const secondDownload = await source.downloadTorrent(detail);

    expect(listings).toHaveLength(2);
    expect(detail.id).toBe('1111111111111111111111111111111111111111');
    expect(Buffer.from(firstDownload)).toEqual(torrentFixture);
    expect(Buffer.from(secondDownload)).toEqual(torrentFixture);
    expect(
      fetchMock.mock.calls.filter(([input]) => requestUrl(input).includes('login.php')),
    ).toHaveLength(1);
  });

  it('does not send credentials when a download URL fails validation', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const source = createSktorrentSource(
      { username: 'test-user', password: 'test-password' },
      { fetch: fetchMock },
    );

    await expect(
      source.downloadTorrent({
        id: '1111111111111111111111111111111111111111',
        title: 'Sample',
        category: 'Film',
        language: 'unknown',
        sizeBytes: 1,
        addedDate: '2026-09-06',
        seeders: 1,
        leechers: 0,
        files: [{ name: 'sample.mp4', sizeBytes: 1 }],
        downloadPath:
          'https://example.com/torrent/download.php?id=1111111111111111111111111111111111111111',
        providerUrl:
          'https://sktorrent.eu/torrent/details.php?id=1111111111111111111111111111111111111111',
      }),
    ).rejects.toThrow('Unexpected SKTorrent URL');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

const htmlResponse = (html: string): Response =>
  new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });

const requestUrl = (input: string | URL | Request): string =>
  typeof input === 'string' || input instanceof URL ? input.toString() : input.url;
