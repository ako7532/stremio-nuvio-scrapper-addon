import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { parseSktorrentTorrent } from '../../../src/providers/sktorrent/sktorrent-torrent-parser.js';

const providerId = '9ca7792139b16d7f68132ed46ce79f649a72b45b';
const fixture = Buffer.from(
  (
    await readFile(new URL('../../fixtures/sktorrent/sintel.torrent.b64', import.meta.url), 'utf8')
  ).trim(),
  'base64',
);

describe('SKTorrent torrent parser', () => {
  it('derives the verified v1 info hash from the sanitized Sintel fixture', () => {
    expect(parseSktorrentTorrent(fixture, providerId)).toEqual({
      infoHash: providerId,
      magnetUri: `magnet:?xt=urn:btih:${providerId}`,
    });
  });

  it('rejects a provider ID that does not match the info dictionary', () => {
    expect(() =>
      parseSktorrentTorrent(fixture, '1111111111111111111111111111111111111111'),
    ).toThrow('SKTorrent provider ID does not match torrent info hash');
  });

  it('rejects malformed torrent metadata and invalid provider IDs', () => {
    expect(() => parseSktorrentTorrent(Buffer.from('not-bencode'), providerId)).toThrow(
      'Invalid SKTorrent torrent metadata',
    );
    expect(() => parseSktorrentTorrent(fixture, 'invalid')).toThrow(
      'Invalid SKTorrent provider ID',
    );
  });
});
