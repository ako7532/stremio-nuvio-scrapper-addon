import { readFile } from 'node:fs/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createIndexerConnectionDiscovery } from '../../src/application/provider-connection-tester.js';
import { createIndexerEndpointPolicy } from '../../src/security/indexer-endpoint-policy.js';

afterEach(() => vi.unstubAllGlobals());

describe('Indexer connection discovery', () => {
  it('returns only eligible public torrent indexers with bounded capability summaries', async () => {
    const discoveryFixture = await readFile(
      new URL('../fixtures/indexers/prowlarr-indexers.json', import.meta.url),
      'utf8',
    );
    const capabilitiesFixture = await readFile(
      new URL('../fixtures/indexers/caps.xml', import.meta.url),
      'utf8',
    );
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(discoveryFixture, 'application/json'))
      .mockResolvedValueOnce(response(capabilitiesFixture, 'application/xml'));
    vi.stubGlobal('fetch', fetchMock);
    const discover = createIndexerConnectionDiscovery({
      endpointPolicy: createIndexerEndpointPolicy(['https://prowlarr.example']),
    });

    await expect(
      discover(
        'prowlarr',
        { endpoint: 'https://prowlarr.example/base/', apiKey: 'fixture-key' },
        8_000,
      ),
    ).resolves.toEqual([
      {
        id: '1',
        name: 'Public Fixture',
        status: 'available',
        capabilities: { movie: true, series: true, generic: true },
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestUrl(fetchMock.mock.calls[0]?.[0]).toString()).not.toContain('fixture-key');
  });

  it('rejects a connection outside the administrator allowlist before network access', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    const discover = createIndexerConnectionDiscovery({
      endpointPolicy: createIndexerEndpointPolicy(['https://allowed.example']),
    });

    await expect(
      discover('jackett', { endpoint: 'https://blocked.example/', apiKey: 'fixture-key' }, 8_000),
    ).rejects.toMatchObject({ kind: 'InvalidConfiguration' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

const response = (body: string, contentType: string): Response =>
  new Response(body, { status: 200, headers: { 'content-type': contentType } });

const requestUrl = (value: string | URL | Request | undefined): URL => {
  if (value instanceof URL) return value;
  if (value instanceof Request) return new URL(value.url);
  if (typeof value === 'string') return new URL(value);
  throw new TypeError('Expected request URL');
};
