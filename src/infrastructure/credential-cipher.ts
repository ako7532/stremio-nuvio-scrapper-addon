import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import type { ProviderCredentials } from '../domain/configuration.js';

export type CredentialCipher = {
  encrypt(credentials: ProviderCredentials): string;
  decrypt(value: string): ProviderCredentials;
};

export function createCredentialCipher(encodedKey: string): CredentialCipher {
  const key = Buffer.from(encodedKey, 'base64');
  if (key.length !== 32 || key.toString('base64') !== encodedKey) {
    throw new TypeError('CONFIG_ENCRYPTION_KEY must be a canonical base64-encoded 32-byte key');
  }
  return {
    encrypt(credentials) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify(credentials), 'utf8'),
        cipher.final(),
      ]);
      return [
        'v1',
        nonce.toString('base64url'),
        cipher.getAuthTag().toString('base64url'),
        ciphertext.toString('base64url'),
      ].join('.');
    },
    decrypt(value) {
      const [version, encodedNonce, encodedTag, encodedCiphertext, extra] = value.split('.');
      if (
        version !== 'v1' ||
        encodedNonce === undefined ||
        encodedTag === undefined ||
        encodedCiphertext === undefined ||
        extra !== undefined
      ) {
        throw new TypeError('Invalid encrypted credential payload');
      }
      try {
        const decipher = createDecipheriv(
          'aes-256-gcm',
          key,
          Buffer.from(encodedNonce, 'base64url'),
        );
        decipher.setAuthTag(Buffer.from(encodedTag, 'base64url'));
        const plaintext = Buffer.concat([
          decipher.update(Buffer.from(encodedCiphertext, 'base64url')),
          decipher.final(),
        ]).toString('utf8');
        return JSON.parse(plaintext) as ProviderCredentials;
      } catch (error) {
        throw new TypeError('Encrypted credentials could not be authenticated', { cause: error });
      }
    },
  };
}
