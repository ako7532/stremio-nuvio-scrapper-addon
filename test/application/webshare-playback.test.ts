import { describe, expect, it, vi } from 'vitest';

import { createWebsharePlaybackAssembly } from '../../src/application/webshare-playback.js';
import type { FileProviderResult } from '../../src/domain/release.js';
import { createPlayTokenService } from '../../src/security/play-token.js';

const result: FileProviderResult = {
  provider: 'webshare',
  source: 'file-hosting',
  id: 'AbCdEf1234',
  fileId: 'AbCdEf1234',
  title: 'Fixture Movie 1080p.mkv',
  releaseName: 'Fixture Movie 1080p.mkv',
  filename: 'Fixture Movie 1080p.mkv',
  mediaType: 'movie',
  providerUrl: 'https://webshare.cz/#/file/AbCdEf1234',
  available: true,
  streamable: true,
};

describe('Webshare playback', () => {
  it('keeps inspection read-only and resolves the selected file once on GET', async () => {
    const resolvePlayback = vi.fn().mockResolvedValue('https://media.example.test/temporary');
    const credential = { username: 'fixture-user', password: 'fixture-password' };
    const assembly = createWebsharePlaybackAssembly({
      baseUrl: 'https://addon.example/base/',
      tokens: createPlayTokenService({ secret: 'fixture-secret-with-at-least-32-bytes' }),
      credentials: {
        get: vi.fn().mockResolvedValue({ configId: 'configuration-id-1234', ...credential }),
      },
      resolvePlayback,
    });
    const url = assembly.urlFactory('configuration-id-1234')(result, {
      type: 'movie',
      id: 'tt0000011',
    });
    const token = new URL(url).pathname.split('/').at(-1) ?? '';

    await assembly.resolver.inspect(token);
    expect(resolvePlayback).not.toHaveBeenCalled();

    const [first, second] = await Promise.all([
      assembly.resolver.resolve(token),
      assembly.resolver.resolve(token),
    ]);
    expect(first.url).toBe('https://media.example.test/temporary');
    expect(second).toEqual(first);
    expect(resolvePlayback).toHaveBeenCalledOnce();
    expect(resolvePlayback).toHaveBeenCalledWith(credential, 'AbCdEf1234', undefined);
    expect(url).not.toContain(credential.username);
    expect(url).not.toContain(credential.password);
    expect(url).not.toContain(result.fileId);
  });

  it('accepts a changing HTTPS playback host returned by Webshare', async () => {
    const assembly = createWebsharePlaybackAssembly({
      baseUrl: 'https://addon.example/',
      tokens: createPlayTokenService({ secret: 'fixture-secret-with-at-least-32-bytes' }),
      credentials: {
        get: vi.fn().mockResolvedValue({
          configId: 'configuration-id-1234',
          username: 'fixture-user',
          password: 'fixture-password',
        }),
      },
      resolvePlayback: vi.fn().mockResolvedValue('https://sub.media.example.test/temporary'),
    });
    const token =
      new URL(
        assembly.urlFactory('configuration-id-1234')(result, { type: 'movie', id: 'tt0000011' }),
      ).pathname
        .split('/')
        .at(-1) ?? '';

    await expect(assembly.resolver.resolve(token)).resolves.toMatchObject({
      url: 'https://sub.media.example.test/temporary',
    });
  });

  it('still rejects non-HTTPS playback URLs and URLs containing credentials', async () => {
    for (const playbackUrl of [
      'http://media.example.test/temporary',
      'https://user:password@media.example.test/temporary',
    ]) {
      const assembly = createWebsharePlaybackAssembly({
        baseUrl: 'https://addon.example/',
        tokens: createPlayTokenService({ secret: 'fixture-secret-with-at-least-32-bytes' }),
        credentials: {
          get: vi.fn().mockResolvedValue({
            configId: 'configuration-id-1234',
            username: 'fixture-user',
            password: 'fixture-password',
          }),
        },
        resolvePlayback: vi.fn().mockResolvedValue(playbackUrl),
      });
      const token =
        new URL(
          assembly.urlFactory('configuration-id-1234')(result, {
            type: 'movie',
            id: 'tt0000011',
          }),
        ).pathname
          .split('/')
          .at(-1) ?? '';

      await expect(assembly.resolver.resolve(token)).rejects.toMatchObject({
        kind: 'invalid-provider-url',
      });
    }
  });
});
