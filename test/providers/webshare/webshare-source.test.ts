import { describe, expect, it, vi } from 'vitest';

import type { WebshareApiClient } from '../../../src/providers/webshare/webshare-api-client.js';
import type { WebshareCredentialService } from '../../../src/providers/webshare/webshare-credentials.js';
import { createWebshareSource } from '../../../src/providers/webshare/webshare-source.js';

const file = (index: number) => ({
  id: `A${String(index).padStart(9, '0')}`,
  name: `Sintel.${String(index)}.1080p.mkv`,
  type: 'mkv',
  sizeBytes: 1_000,
  passwordProtected: false,
});

const apiStub = () => {
  const search = vi.fn<WebshareApiClient['search']>().mockResolvedValue([file(1)]);
  const getFileInfo = vi.fn<WebshareApiClient['getFileInfo']>().mockResolvedValue({
    ...file(1),
    available: true,
    removed: false,
    copyrighted: false,
  });
  const getPlaybackLink = vi
    .fn<WebshareApiClient['getPlaybackLink']>()
    .mockResolvedValue('https://cdn.example.invalid/video');
  const api: WebshareApiClient = {
    getSalt: vi.fn(),
    login: vi.fn(),
    search,
    getFileInfo,
    getAvailability: vi.fn().mockResolvedValue({ exists: true, downloadable: true }),
    getPlaybackLink,
  };
  return { api, search, getFileInfo, getPlaybackLink };
};

describe('Webshare source', () => {
  it('combines public metadata and availability without authenticating during search', async () => {
    const { api } = apiStub();
    const getSessionToken = vi.fn();
    const credentials: WebshareCredentialService = { getSessionToken };
    const source = createWebshareSource(api, credentials);

    await expect(source.search('Sintel')).resolves.toEqual([
      expect.objectContaining({
        id: 'A000000001',
        available: true,
        streamable: true,
        providerUrl: 'https://webshare.cz/#/file/A000000001',
      }),
    ]);
    expect(getSessionToken).not.toHaveBeenCalled();
  });

  it('does not request metadata for password-protected search results', async () => {
    const { api, search, getFileInfo } = apiStub();
    search.mockResolvedValue([{ ...file(2), passwordProtected: true }]);
    const source = createWebshareSource(api, { getSessionToken: vi.fn() });

    await expect(source.search('Sintel')).resolves.toEqual([]);
    expect(getFileInfo).not.toHaveBeenCalled();
  });

  it('authenticates only when playback is resolved', async () => {
    const { api, getPlaybackLink } = apiStub();
    const getSessionToken = vi.fn().mockResolvedValue('session-token');
    const credentials: WebshareCredentialService = {
      getSessionToken,
    };
    const source = createWebshareSource(api, credentials);

    await expect(source.resolvePlayback('A000000001')).resolves.toBe(
      'https://cdn.example.invalid/video',
    );
    expect(getPlaybackLink).toHaveBeenCalledWith('A000000001', 'session-token', undefined);
  });

  it('caps and bounds metadata lookups', async () => {
    let active = 0;
    let maximumActive = 0;
    const { api, search, getFileInfo } = apiStub();
    search.mockResolvedValue(Array.from({ length: 5 }, (_, index) => file(index)));
    getFileInfo.mockImplementation(async (id) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active -= 1;
      return { ...file(Number(id.slice(1))), available: true, removed: false, copyrighted: false };
    });
    const source = createWebshareSource(
      api,
      { getSessionToken: vi.fn() },
      {
        maximumResults: 3,
        detailConcurrency: 2,
      },
    );

    await expect(source.search('Sintel')).resolves.toHaveLength(3);
    expect(getFileInfo).toHaveBeenCalledTimes(3);
    expect(maximumActive).toBeLessThanOrEqual(2);
  });
});
