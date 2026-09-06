import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { z } from 'zod';

import { mediaTypes } from '../domain/media.js';

const claimsSchema = z.object({
  configId: z.string().min(16).max(200),
  referenceId: z.string().min(16).max(200),
  provider: z.literal('sktorrent'),
  providerResultId: z.string().min(1).max(200),
  infoHash: z.string().regex(/^[a-f\d]{40}$/u),
  mediaType: z.enum(mediaTypes),
  mediaId: z.string().min(1).max(200),
  season: z.number().int().min(0).optional(),
  episode: z.number().int().positive().optional(),
  expiresAt: z.number().int().positive(),
});

export type PlayTokenClaims = z.infer<typeof claimsSchema>;
export type NewPlayTokenClaims = Omit<PlayTokenClaims, 'expiresAt'>;

export class PlayTokenError extends Error {
  override readonly name = 'PlayTokenError';

  constructor(
    readonly kind: 'invalid' | 'expired',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
  }
}

export type PlayTokenService = {
  issue(claims: NewPlayTokenClaims): string;
  verify(token: string): PlayTokenClaims;
};

export type PlayTokenServiceOptions = {
  secret: string | Uint8Array;
  ttlMs?: number;
  clock?: () => number;
  randomBytes?: (size: number) => Buffer;
};

const DEFAULT_TTL_MS = 5 * 60 * 1_000;

export const createPlayTokenService = (options: PlayTokenServiceOptions): PlayTokenService => {
  const key = deriveKey(options.secret);
  const ttlMs = positiveInteger(options.ttlMs ?? DEFAULT_TTL_MS, 'play token TTL');
  const clock = options.clock ?? Date.now;
  const getRandomBytes = options.randomBytes ?? randomBytes;

  return {
    issue(claims) {
      const parsedClaims = claimsSchema.omit({ expiresAt: true }).parse(claims);
      const payload = Buffer.from(
        JSON.stringify({ ...parsedClaims, expiresAt: clock() + ttlMs }),
        'utf8',
      );
      const initializationVector = getRandomBytes(12);
      if (initializationVector.byteLength !== 12) {
        throw new TypeError('Play token IV generator must return 12 bytes');
      }
      const cipher = createCipheriv('aes-256-gcm', key, initializationVector);
      const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
      return [
        'v1',
        initializationVector.toString('base64url'),
        ciphertext.toString('base64url'),
        cipher.getAuthTag().toString('base64url'),
      ].join('.');
    },
    verify(token) {
      try {
        const parts = token.split('.');
        if (parts.length !== 4 || parts[0] !== 'v1') throw invalidToken();
        const initializationVector = decodePart(parts[1]);
        const ciphertext = decodePart(parts[2]);
        const authenticationTag = decodePart(parts[3]);
        if (initializationVector.byteLength !== 12 || authenticationTag.byteLength !== 16) {
          throw invalidToken();
        }
        const decipher = createDecipheriv('aes-256-gcm', key, initializationVector);
        decipher.setAuthTag(authenticationTag);
        const payload = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        const claims = claimsSchema.parse(JSON.parse(payload.toString('utf8')));
        if (claims.expiresAt <= clock()) {
          throw new PlayTokenError('expired', 'Play token has expired');
        }
        return claims;
      } catch (error) {
        if (error instanceof PlayTokenError) throw error;
        throw new PlayTokenError('invalid', 'Play token is invalid', { cause: error });
      }
    },
  };
};

const deriveKey = (secret: string | Uint8Array): Buffer => {
  const bytes = typeof secret === 'string' ? Buffer.from(secret, 'utf8') : Buffer.from(secret);
  if (bytes.byteLength < 32)
    throw new TypeError('Play token secret must contain at least 32 bytes');
  return createHash('sha256').update(bytes).digest();
};

const decodePart = (value: string | undefined): Buffer => {
  if (value === undefined || value.length === 0 || !/^[A-Za-z\d_-]+$/u.test(value)) {
    throw invalidToken();
  }
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) throw invalidToken();
  return decoded;
};

const invalidToken = (): PlayTokenError => new PlayTokenError('invalid', 'Play token is invalid');

const positiveInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be positive`);
  return value;
};
