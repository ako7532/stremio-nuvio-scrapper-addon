import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createCredentialCipher } from '../../src/infrastructure/credential-cipher.js';

describe('credential cipher', () => {
  it('round-trips credentials without placing plaintext in the stored value', () => {
    const cipher = createCredentialCipher(randomBytes(32).toString('base64'));
    const encrypted = cipher.encrypt({
      torbox: { apiKey: 'server-held-torbox-key' },
      webshare: { username: 'fixture-user', password: 'fixture-password' },
    });

    expect(encrypted).not.toContain('server-held-torbox-key');
    expect(encrypted).not.toContain('fixture-password');
    expect(cipher.decrypt(encrypted)).toEqual({
      torbox: { apiKey: 'server-held-torbox-key' },
      webshare: { username: 'fixture-user', password: 'fixture-password' },
    });
  });

  it('rejects a tampered payload and invalid master key', () => {
    const cipher = createCredentialCipher(randomBytes(32).toString('base64'));
    const encrypted = cipher.encrypt({ torbox: { apiKey: 'fixture-key' } });

    expect(() => cipher.decrypt(`${encrypted.slice(0, -1)}A`)).toThrow(
      'could not be authenticated',
    );
    expect(() => createCredentialCipher('not-a-key')).toThrow('CONFIG_ENCRYPTION_KEY');
  });
});
