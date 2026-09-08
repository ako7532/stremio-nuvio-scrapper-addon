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
    expect(response.body).toContain('Public Indexers are configured once on the server');
    expect(response.body).not.toContain('name="indexersEnabled"');
    expect(response.body).not.toContain('name="indexersEndpoint"');
    expect(response.body).not.toContain('/api/indexers/discover');
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

  it('strips legacy per-user Indexers settings and credentials', async () => {
    const store = memoryStore();
    const service = createConfigurationService(store);
    const defaults = defaultConfiguration();
    const legacy = {
      id: 'legacy-configuration-fixture-123',
      configuration: {
        ...defaults,
        providers: {
          ...defaults.providers,
          indexers: {
            enabled: true,
            backend: 'prowlarr',
            selectedIndexerIds: ['public-fixture'],
          },
        },
      },
      credentials: {
        indexers: {
          endpoint: 'https://legacy-indexers.invalid/base',
          apiKey: 'legacy-indexers-key-fixture',
        },
      },
      createdAt: '2026-09-06T00:00:00.000Z',
      updatedAt: '2026-09-06T00:00:00.000Z',
    } as unknown as StoredConfiguration;
    store.values.set(legacy.id, legacy);

    const normalized = await service.getStored(legacy.id);

    expect(normalized?.configuration.providers).not.toHaveProperty('indexers');
    expect(normalized?.credentials).not.toHaveProperty('indexers');

    const created = await service.create(
      {
        configuration: legacy.configuration,
        credentials: {
          indexers: {
            endpoint: 'https://ignored-indexers.invalid/base',
            apiKey: 'ignored-indexers-key-fixture',
          },
          torbox: { apiKey: 'torbox-key-fixture' },
        },
      },
      'https://addon.example',
    );

    expect(created.configuration.providers).not.toHaveProperty('indexers');
    expect(created.credentials).not.toHaveProperty('indexers');
    expect(store.values.get(created.id)?.credentials).not.toHaveProperty('indexers');
  });

  it('does not expose a public Indexers discovery endpoint', async () => {
    const server = buildServer();
    servers.push(server);

    const response = await server.inject({ method: 'POST', url: '/api/indexers/discover' });

    expect(response.statusCode).toBe(404);
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
