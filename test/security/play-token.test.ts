import { describe, expect, it } from 'vitest';

import { createPlayTokenService, PlayTokenError } from '../../src/security/play-token.js';

const claims = {
  configId: 'config-reference-1234',
  referenceId: 'result-reference-1234',
  provider: 'sktorrent' as const,
  providerResultId: 'provider-result',
  infoHash: 'a'.repeat(40),
  mediaType: 'series' as const,
  mediaId: 'tt1234567',
  season: 1,
  episode: 2,
};

describe('play token service', () => {
  it('round-trips authenticated encrypted claims without exposing them in the token', () => {
    const service = createPlayTokenService({
      secret: 'fixture-secret-with-at-least-32-bytes',
      ttlMs: 1_000,
      clock: () => 10_000,
      randomBytes: () => Buffer.alloc(12, 7),
    });

    const token = service.issue(claims);

    expect(token).not.toContain(claims.configId);
    expect(token).not.toContain(claims.infoHash);
    expect(service.verify(token)).toEqual({ ...claims, expiresAt: 11_000 });
  });

  it('rejects tampering and expiration', () => {
    let now = 10_000;
    const service = createPlayTokenService({
      secret: 'fixture-secret-with-at-least-32-bytes',
      ttlMs: 100,
      clock: () => now,
    });
    const token = service.issue(claims);
    const tampered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;

    expect(() => service.verify(tampered)).toThrow(PlayTokenError);
    now = 10_100;
    expect(() => service.verify(token)).toThrow(
      expect.objectContaining({ kind: 'expired' }) as Error,
    );
  });

  it('accepts Indexers as an encrypted torrent playback provider', () => {
    const service = createPlayTokenService({
      secret: 'fixture-secret-with-at-least-32-bytes',
      clock: () => 10_000,
    });

    const token = service.issue({ ...claims, provider: 'indexers' });

    expect(service.verify(token)).toMatchObject({
      provider: 'indexers',
      infoHash: claims.infoHash,
    });
  });
});
