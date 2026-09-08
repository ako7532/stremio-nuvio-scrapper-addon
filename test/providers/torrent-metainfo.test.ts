import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { calculateV1InfoHash, TorrentMetainfoError } from '../../src/providers/torrent-metainfo.js';

describe('torrent metainfo', () => {
  it('hashes the exact raw bencoded info dictionary', async () => {
    const encoded = await readFile(
      new URL('../fixtures/sktorrent/sintel.torrent.b64', import.meta.url),
      'utf8',
    );

    expect(calculateV1InfoHash(Buffer.from(encoded.trim(), 'base64'))).toBe(
      '9ca7792139b16d7f68132ed46ce79f649a72b45b',
    );
  });

  it('rejects malformed metainfo without an info dictionary', () => {
    expect(() => calculateV1InfoHash(Buffer.from('d3:fooi1ee'))).toThrow(TorrentMetainfoError);
  });
});
