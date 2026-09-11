import { describe, expect, it } from 'vitest';

import {
  identityFromMagnet,
  normalizeBtih,
  resolveV1TorrentIdentity,
  TorrentIdentityError,
} from '../../../src/providers/indexers/torrent-identity.js';

describe('torrent identity', () => {
  it('normalizes hexadecimal and base32 v1 identities', () => {
    expect(normalizeBtih('A'.repeat(40))).toBe('a'.repeat(40));
    expect(normalizeBtih('CEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIR')).toBe('11'.repeat(20));
  });

  it('extracts a v1 identity from a magnet and rejects conflicts', () => {
    const hash = 'a'.repeat(40);
    expect(identityFromMagnet(`magnet:?xt=urn:btih:${hash}&dn=Fixture`)).toEqual({
      kind: 'btih',
      infoHash: hash,
    });
    expect(() =>
      resolveV1TorrentIdentity({
        declaredInfoHash: hash,
        magnetUri: `magnet:?xt=urn:btih:${'b'.repeat(40)}`,
      }),
    ).toThrow(expect.objectContaining({ kind: 'conflict' }) as TorrentIdentityError);
  });

  it('does not truncate or reinterpret v2-only identities', () => {
    expect(() => normalizeBtih('a'.repeat(64))).toThrow(
      expect.objectContaining({ kind: 'unsupported-v2' }) as TorrentIdentityError,
    );
    expect(() => identityFromMagnet('magnet:?xt=urn:btmh:1220abcd')).toThrow(
      expect.objectContaining({ kind: 'unsupported-v2' }) as TorrentIdentityError,
    );
  });
});
