import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { describe, expect, it, vi } from 'vitest';

import { createIndexerEndpointPolicy } from '../../src/security/indexer-endpoint-policy.js';

describe('Indexer endpoint policy', () => {
  it('allows only exact administrator-approved origins while preserving path prefixes', () => {
    const policy = createIndexerEndpointPolicy([
      'https://indexers.example',
      'http://prowlarr:9696',
    ]);

    expect(policy.assertAllowed('https://indexers.example/base/').pathname).toBe('/base/');
    expect(policy.assertAllowed('http://prowlarr:9696/').origin).toBe('http://prowlarr:9696');
    expect(() => policy.assertAllowed('https://other.example/')).toThrow();
    expect(() => policy.assertAllowed('http://indexers.example/')).toThrow();
  });

  it('rejects URL credentials, query data, fragments, and path-bearing allowlist entries', () => {
    const policy = createIndexerEndpointPolicy(['https://indexers.example']);

    expect(() => policy.assertAllowed('https://user@indexers.example/')).toThrow();
    expect(() => policy.assertAllowed('https://indexers.example/?key=value')).toThrow();
    expect(() => policy.assertAllowed('https://indexers.example/#fragment')).toThrow();
    expect(() => createIndexerEndpointPolicy(['https://indexers.example/base'])).toThrow();
  });

  it('pins an approved public address and rejects DNS rebinding to a private address', async () => {
    const connect = vi.fn().mockResolvedValue(new Response('ok'));
    const lookup = vi
      .fn()
      .mockResolvedValueOnce([{ address: '203.0.113.10', family: 4 as const }])
      .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 as const }]);
    const policy = createIndexerEndpointPolicy(['https://indexers.example'], {
      lookup,
      connect,
    });

    await expect(policy.request(new URL('https://indexers.example/api'))).resolves.toBeInstanceOf(
      Response,
    );
    expect(connect).toHaveBeenCalledWith(
      new URL('https://indexers.example/api'),
      {},
      { address: '203.0.113.10', family: 4 },
    );
    await expect(policy.request(new URL('https://indexers.example/api'))).rejects.toThrow(
      'private network address',
    );
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('allows explicit Docker/private origins but always blocks link-local destinations', async () => {
    const connect = vi.fn().mockResolvedValue(new Response('ok'));
    const lookup = vi.fn((hostname: string) =>
      Promise.resolve(
        hostname === 'prowlarr'
          ? [{ address: '172.20.0.5', family: 4 as const }]
          : [{ address: '169.254.169.254', family: 4 as const }],
      ),
    );
    const policy = createIndexerEndpointPolicy(['http://prowlarr:9696', 'http://169.254.169.254'], {
      lookup,
      connect,
    });

    await expect(policy.request(new URL('http://prowlarr:9696/api'))).resolves.toBeInstanceOf(
      Response,
    );
    await expect(policy.request(new URL('http://169.254.169.254/latest'))).rejects.toThrow(
      'forbidden network address',
    );
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('supports the Node HTTP all-address lookup contract when using the pinned transport', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('ok');
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });

    try {
      const address = server.address() as AddressInfo;
      const origin = `http://127.0.0.1:${String(address.port)}`;
      const policy = createIndexerEndpointPolicy([origin]);

      const response = await policy.request(new URL('/health', origin));

      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe('ok');
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      });
    }
  });

  it('treats IPv4-mapped IPv6 loopback as private', async () => {
    const connect = vi.fn().mockResolvedValue(new Response('ok'));
    const policy = createIndexerEndpointPolicy(['https://indexers.example'], {
      lookup: () => Promise.resolve([{ address: '::ffff:127.0.0.1', family: 6 }]),
      connect,
    });

    await expect(policy.request(new URL('https://indexers.example/api'))).rejects.toThrow(
      'private network address',
    );
    expect(connect).not.toHaveBeenCalled();
  });
});
