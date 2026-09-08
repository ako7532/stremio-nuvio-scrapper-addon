import { Script } from 'node:vm';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createConfigurationService } from '../../src/application/configuration-service.js';
import type {
  ConfigurationStore,
  StoredConfiguration,
} from '../../src/application/configuration-store.js';
import type { SearchStreams } from '../../src/application/search-streams.js';
import { defaultConfiguration } from '../../src/domain/configuration-defaults.js';
import { buildServer } from '../../src/http/server.js';
import { createIndexerEndpointPolicy } from '../../src/security/indexer-endpoint-policy.js';

const servers: ReturnType<typeof buildServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => server.close()));
});

describe('configuration HTTP API', () => {
  it('serves a responsive custom configure page', async () => {
    const server = buildServer();
    servers.push(server);

    const response = await server.inject({ method: 'GET', url: '/configure' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('name="viewport"');
    expect(response.body).toContain('Test TorBox');
    expect(response.body).toContain('Test TMDB');
    expect(response.body).toContain('How to finish setup');
    expect(response.body).toContain('data-test-status="tmdb"');
    expect(response.body).toContain('.test-status.error{color:var(--danger)}');
    expect(response.body).toContain("status.classList.toggle('error'");
    expect(response.body).toContain('id="streamPreview"');
    expect(response.body).toContain('1 is the highest priority');
    expect(response.body).toContain('TorBox is contacted only after you open an SKTorrent source');
    expect(response.body).toContain('name="resultLimitPerQuality"');
    expect(response.body).toContain('perResolution=perQualityValue');
    expect(response.body).toContain('name="safeDebug" type="checkbox"');
    expect(response.body).toContain("safeDebug:field('safeDebug').checked");
    expect(response.body).toContain('name="indexersEnabled"');
    expect(response.body).toContain("selectedIndexerIds:checked('selectedIndexerIds')");
    expect(response.body).toContain('/api/indexers/discover');
    expect(response.body).toContain('target="_blank" rel="noreferrer"');
    expect(response.body).not.toContain('server-held-fixture-key');
    const nonce = /<script nonce="([^"]+)">/u.exec(response.body)?.[1] ?? '';
    const script = /<script nonce="[^"]+">([\s\S]+)<\/script>/u.exec(response.body)?.[1];
    expect(nonce).not.toBe('');
    expect(script).toBeDefined();
    expect(() => new Script(script ?? '')).not.toThrow();
    expect(response.headers['content-security-policy']).toContain("default-src 'none'");
    expect(response.headers['content-security-policy']).toContain(`script-src 'nonce-${nonce}'`);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('normalizes legacy settings and keeps Indexers connection secrets server-side', async () => {
    const store = memoryStore();
    const service = createConfigurationService(store, {
      indexerEndpointPolicy: createIndexerEndpointPolicy(['https://indexers.invalid']),
    });
    const legacyConfiguration = defaultConfiguration();
    delete legacyConfiguration.providers.indexers;
    const legacy: StoredConfiguration = {
      id: 'legacy-configuration-fixture-123',
      configuration: legacyConfiguration,
      credentials: {},
      createdAt: '2026-09-06T00:00:00.000Z',
      updatedAt: '2026-09-06T00:00:00.000Z',
    };
    store.values.set(legacy.id, legacy);

    await expect(service.getStored(legacy.id)).resolves.toMatchObject({
      configuration: {
        providers: {
          indexers: { enabled: false, backend: 'prowlarr', selectedIndexerIds: [] },
        },
      },
    });

    const endpoint = 'https://indexers.invalid/prowlarr';
    const apiKey = 'indexers-api-key-fixture';
    const configuration = defaultConfiguration();
    configuration.providers.indexers = {
      enabled: true,
      backend: 'jackett',
      selectedIndexerIds: ['public-one', 'public-two'],
    };
    await expect(
      service.create(
        { configuration, credentials: { indexers: { endpoint, apiKey } } },
        'https://addon.example',
      ),
    ).rejects.toMatchObject({ kind: 'InvalidConfiguration' });
    const created = await service.create(
      {
        configuration,
        credentials: {
          indexers: { endpoint, apiKey },
          torbox: { apiKey: 'torbox-key-fixture' },
        },
      },
      'https://addon.example',
    );

    expect(created.configuration.providers.indexers).toEqual(configuration.providers.indexers);
    expect(created.credentials.indexers).toEqual({ configured: true });
    expect(JSON.stringify(created)).not.toContain(endpoint);
    expect(JSON.stringify(created)).not.toContain(apiKey);
    expect(store.values.get(created.id)?.credentials.indexers).toEqual({ endpoint, apiKey });

    await service.update(
      created.id,
      { configuration: defaultConfiguration(), credentials: {} },
      'https://addon.example',
    );
    expect(store.values.get(created.id)?.credentials.indexers).toEqual({ endpoint, apiKey });

    const replacement = {
      endpoint: 'https://indexers.invalid/jackett',
      apiKey: 'replacement-indexers-key-fixture',
    };
    await service.update(
      created.id,
      {
        configuration: defaultConfiguration(),
        credentials: { indexers: replacement },
      },
      'https://addon.example',
    );
    expect(store.values.get(created.id)?.credentials.indexers).toEqual(replacement);

    const removed = await service.update(
      created.id,
      { configuration: defaultConfiguration(), credentials: { indexers: null } },
      'https://addon.example',
    );
    expect(removed?.credentials.indexers).toEqual({ configured: false });
    expect(store.values.get(created.id)?.credentials.indexers).toBeUndefined();
  });

  it('discovers Indexers through stored or submitted credentials without returning secrets', async () => {
    const store = memoryStore();
    const service = createConfigurationService(store);
    const configuration = defaultConfiguration();
    configuration.providers.indexers = {
      enabled: false,
      backend: 'jackett',
      selectedIndexerIds: [],
    };
    const stored: StoredConfiguration = {
      id: 'indexers-discovery-fixture-12345',
      configuration,
      credentials: {
        indexers: {
          endpoint: 'https://stored-indexers.invalid/base',
          apiKey: 'stored-indexers-key-fixture',
        },
      },
      createdAt: '2026-09-08T00:00:00.000Z',
      updatedAt: '2026-09-08T00:00:00.000Z',
    };
    store.values.set(stored.id, stored);
    const indexerConnectionDiscovery = vi.fn().mockResolvedValue([
      {
        id: 'public-fixture',
        name: 'Public fixture',
        status: 'available',
        capabilities: { movie: true, series: true, generic: true },
      },
    ]);
    const server = buildServer({
      configurationService: service,
      indexerConnectionDiscovery,
    });
    servers.push(server);

    const response = await server.inject({
      method: 'POST',
      url: '/api/indexers/discover',
      payload: { configurationId: stored.id },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'ok',
      indexers: [{ id: 'public-fixture', status: 'available' }],
    });
    expect(indexerConnectionDiscovery).toHaveBeenCalledWith(
      'jackett',
      stored.credentials.indexers,
      8_000,
      undefined,
    );
    expect(response.body).not.toContain('stored-indexers-key-fixture');
    expect(response.body).not.toContain('stored-indexers.invalid');
  });

  it('creates, safely reads, updates, and revokes an opaque configuration', async () => {
    const store = memoryStore();
    const invalidateConfigurationRuntime = vi.fn();
    const server = buildServer({
      configurationService: createConfigurationService(store),
      publicBaseUrl: 'https://addon.example/base/',
      invalidateConfigurationRuntime,
    });
    servers.push(server);
    const secret = 'server-held-fixture-key';
    const tmdbSecret = 'server-held-tmdb-token';

    const created = await server.inject({
      method: 'POST',
      url: '/api/configurations',
      payload: {
        configuration: defaultConfiguration(),
        credentials: { tmdb: { accessToken: tmdbSecret }, torbox: { apiKey: secret } },
      },
    });

    expect(created.statusCode).toBe(200);
    expect(created.body).not.toContain(secret);
    expect(created.body).not.toContain(tmdbSecret);
    const publicValue = created.json<{
      id: string;
      manifestUrl: string;
      credentials: {
        tmdb: { configured: boolean; masked: string };
        torbox: { configured: boolean; masked: string };
      };
    }>();
    expect(publicValue.id).toMatch(/^[A-Za-z\d_-]{32}$/u);
    expect(publicValue.manifestUrl).toBe(
      `https://addon.example/base/${publicValue.id}/manifest.json`,
    );
    expect(publicValue.credentials.torbox).toEqual({
      configured: true,
      masked: '••••••••-key',
    });
    expect(store.values.get(publicValue.id)?.credentials.torbox?.apiKey).toBe(secret);
    expect(store.values.get(publicValue.id)?.credentials.tmdb?.accessToken).toBe(tmdbSecret);
    expect(publicValue.credentials.tmdb).toEqual({
      configured: true,
      masked: '••••••••oken',
    });

    const manifest = await server.inject({
      method: 'GET',
      url: `/${publicValue.id}/manifest.json`,
    });
    expect(manifest.statusCode).toBe(200);
    expect(manifest.body).not.toContain(secret);
    expect(manifest.body).not.toContain(tmdbSecret);

    const updated = await server.inject({
      method: 'PUT',
      url: `/api/configurations/${publicValue.id}`,
      payload: { configuration: defaultConfiguration(), credentials: { torbox: null } },
    });
    expect(updated.json()).toMatchObject({ credentials: { torbox: { configured: false } } });
    expect(store.values.get(publicValue.id)?.credentials.torbox).toBeUndefined();
    expect(invalidateConfigurationRuntime).toHaveBeenCalledWith(publicValue.id);

    const revoked = await server.inject({
      method: 'DELETE',
      url: `/api/configurations/${publicValue.id}`,
    });
    expect(revoked.json()).toEqual({ revoked: true });
    expect(invalidateConfigurationRuntime).toHaveBeenCalledTimes(2);
    expect(
      (await server.inject({ method: 'GET', url: `/${publicValue.id}/manifest.json` })).statusCode,
    ).toBe(404);
  });

  it('tests a provider using server-held credentials and returns only sanitized status', async () => {
    const store = memoryStore();
    const service = createConfigurationService(store);
    const created = await service.create(
      {
        configuration: defaultConfiguration(),
        credentials: { torbox: { apiKey: 'saved-private-key' } },
      },
      'https://addon.example',
    );
    const providerConnectionTester = vi.fn().mockResolvedValue(undefined);
    const server = buildServer({ configurationService: service, providerConnectionTester });
    servers.push(server);

    const response = await server.inject({
      method: 'POST',
      url: '/api/provider-tests/torbox',
      payload: { configurationId: created.id },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    expect(providerConnectionTester).toHaveBeenCalledWith(
      'torbox',
      { apiKey: 'saved-private-key' },
      8_000,
      undefined,
    );
    expect(response.body).not.toContain('saved-private-key');
  });

  it('resolves configured streams through the stored configuration boundary', async () => {
    const store = memoryStore();
    const service = createConfigurationService(store);
    const created = await service.create(
      { configuration: defaultConfiguration(), credentials: {} },
      'https://addon.example',
    );
    const search = vi
      .fn<SearchStreams['search']>()
      .mockResolvedValue([{ name: 'Fixture', title: 'Configured result' }]);
    const searchStreamsForConfiguration = vi.fn().mockReturnValue({ search });
    const server = buildServer({ configurationService: service, searchStreamsForConfiguration });
    servers.push(server);

    const response = await server.inject({
      method: 'GET',
      url: `/${created.id}/stream/movie/tt0111161.json`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      streams: [{ name: 'Fixture', title: 'Configured result' }],
    });
    expect(searchStreamsForConfiguration).toHaveBeenCalledWith(
      expect.objectContaining({ id: created.id, credentials: {} }),
    );
    expect(search).toHaveBeenCalledOnce();
    expect(search.mock.calls[0]?.[0]).toEqual({ type: 'movie', id: 'tt0111161' });
    expect(typeof search.mock.calls[0]?.[1].correlationId).toBe('string');
    expect(search.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal);
  });
});

function memoryStore(): ConfigurationStore & { values: Map<string, StoredConfiguration> } {
  const values = new Map<string, StoredConfiguration>();
  return {
    values,
    get(id) {
      return Promise.resolve(values.get(id));
    },
    save(value) {
      values.set(value.id, structuredClone(value));
      return Promise.resolve();
    },
    delete(id) {
      return Promise.resolve(values.delete(id));
    },
  };
}
