import { createHash } from 'node:crypto';

import type { WebshareApiClient } from './webshare-api-client.js';

export type WebshareCredentials = {
  username: string;
  password: string;
};

export type WebshareCredentialService = {
  getSessionToken(signal?: AbortSignal): Promise<string>;
};

const CRYPT_ALPHABET = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export const createWebshareCredentialService = (
  api: WebshareApiClient,
  credentials: WebshareCredentials,
): WebshareCredentialService => {
  const username = requiredCredential(credentials.username, 'username');
  const password = requiredCredential(credentials.password, 'password');
  let session: Promise<string> | undefined;

  return {
    getSessionToken(signal) {
      session ??= authenticate(api, username, password, signal);
      return session.catch((error: unknown) => {
        session = undefined;
        throw error;
      });
    },
  };
};

export const createWebsharePasswordDigest = (password: string, salt: string): string => {
  const crypted = md5Crypt(requiredCredential(password, 'password'), normalizeSalt(salt));
  return createHash('sha1').update(crypted, 'utf8').digest('hex');
};

const authenticate = async (
  api: WebshareApiClient,
  username: string,
  password: string,
  signal?: AbortSignal,
): Promise<string> => {
  const salt = await api.getSalt(username, signal);
  return api.login(username, createWebsharePasswordDigest(password, salt), signal);
};

const md5Crypt = (password: string, salt: string): string => {
  const passwordBytes = Buffer.from(password, 'utf8');
  const saltBytes = Buffer.from(salt, 'utf8');
  const magic = Buffer.from('$1$', 'ascii');
  const parts: Buffer[] = [passwordBytes, magic, saltBytes];
  const alternate = md5(Buffer.concat([passwordBytes, saltBytes, passwordBytes]));
  for (let remaining = passwordBytes.length; remaining > 0; remaining -= 16) {
    parts.push(alternate.subarray(0, Math.min(16, remaining)));
  }
  for (let length = passwordBytes.length; length > 0; length >>= 1) {
    parts.push((length & 1) === 1 ? Buffer.from([0]) : passwordBytes.subarray(0, 1));
  }
  let digest = md5(Buffer.concat(parts));
  for (let round = 0; round < 1_000; round += 1) {
    const roundParts: Buffer[] = [];
    roundParts.push((round & 1) === 1 ? passwordBytes : digest);
    if (round % 3 !== 0) roundParts.push(saltBytes);
    if (round % 7 !== 0) roundParts.push(passwordBytes);
    roundParts.push((round & 1) === 1 ? digest : passwordBytes);
    digest = md5(Buffer.concat(roundParts));
  }
  const encoded = [
    cryptBase64(digest[0], digest[6], digest[12], 4),
    cryptBase64(digest[1], digest[7], digest[13], 4),
    cryptBase64(digest[2], digest[8], digest[14], 4),
    cryptBase64(digest[3], digest[9], digest[15], 4),
    cryptBase64(digest[4], digest[10], digest[5], 4),
    cryptBase64(0, 0, digest[11], 2),
  ].join('');
  return `$1$${salt}$${encoded}`;
};

const md5 = (value: Buffer): Buffer => createHash('md5').update(value).digest();

const cryptBase64 = (
  high: number | undefined,
  middle: number | undefined,
  low: number | undefined,
  length: number,
): string => {
  let value = ((high ?? 0) << 16) | ((middle ?? 0) << 8) | (low ?? 0);
  let output = '';
  for (let index = 0; index < length; index += 1) {
    output += CRYPT_ALPHABET.charAt(value & 0x3f);
    value >>= 6;
  }
  return output;
};

const normalizeSalt = (value: string): string => {
  const salt =
    value
      .replace(/^\$1\$/u, '')
      .split('$', 1)[0]
      ?.slice(0, 8) ?? '';
  if (salt.length === 0 || !/^[./A-Za-z0-9]+$/u.test(salt)) {
    throw new TypeError('Invalid Webshare password salt');
  }
  return salt;
};

const requiredCredential = (value: string, name: string): string => {
  if (value.trim().length === 0) {
    throw new TypeError(`Webshare ${name} must not be empty`);
  }
  return value;
};
