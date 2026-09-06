import { describe, expect, it, vi } from 'vitest';

import type { WebshareApiClient } from '../../../src/providers/webshare/webshare-api-client.js';
import {
  createWebshareCredentialService,
  createWebsharePasswordDigest,
} from '../../../src/providers/webshare/webshare-credentials.js';

const apiStub = () => {
  const getSalt = vi.fn().mockResolvedValue('5pZSV9va');
  const login = vi.fn().mockResolvedValue('session-token');
  const api: WebshareApiClient = {
    getSalt,
    login,
    search: vi.fn(),
    getFileInfo: vi.fn(),
    getAvailability: vi.fn(),
    getPlaybackLink: vi.fn(),
  };
  return { api, getSalt, login };
};

describe('Webshare credential service', () => {
  it('implements SHA1(MD5_CRYPT(password)) using a published MD5-crypt vector', () => {
    expect(createWebsharePasswordDigest('password', '5pZSV9va')).toBe(
      'aceb037344ebcdb8fab36ac2d21468ee1f6adbe1',
    );
  });

  it('owns credentials and reuses only the resulting session token', async () => {
    const { api, getSalt, login } = apiStub();
    const service = createWebshareCredentialService(api, {
      username: 'fixture-user',
      password: 'password',
    });

    await expect(
      Promise.all([service.getSessionToken(), service.getSessionToken()]),
    ).resolves.toEqual(['session-token', 'session-token']);
    expect(getSalt).toHaveBeenCalledOnce();
    expect(login).toHaveBeenCalledOnce();
    expect(login).toHaveBeenCalledWith(
      'fixture-user',
      'aceb037344ebcdb8fab36ac2d21468ee1f6adbe1',
      undefined,
    );
  });

  it('does not retain a failed authentication promise', async () => {
    const { api, getSalt } = apiStub();
    getSalt.mockRejectedValueOnce(new Error('authentication failed'));
    const service = createWebshareCredentialService(api, {
      username: 'fixture-user',
      password: 'password',
    });

    await expect(service.getSessionToken()).rejects.toThrow('authentication failed');
    await expect(service.getSessionToken()).resolves.toBe('session-token');
    expect(getSalt).toHaveBeenCalledTimes(2);
  });
});
