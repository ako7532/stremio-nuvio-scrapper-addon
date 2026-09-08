import { describe, expect, it } from 'vitest';

import { parseEnvironment } from '../../src/infrastructure/environment.js';

describe('environment', () => {
  it('uses safe local defaults', () => {
    expect(parseEnvironment({})).toMatchObject({
      HOST: '0.0.0.0',
      PORT: 7000,
      LOG_LEVEL: 'info',
      TRUST_PROXY: false,
      SHUTDOWN_TIMEOUT_MS: 10_000,
      INDEXER_ALLOWED_ORIGINS: [],
    });
  });

  it('rejects invalid ports', () => {
    expect(() => parseEnvironment({ PORT: '70000' })).toThrow();
  });

  it('requires an explicit boolean reverse-proxy setting', () => {
    expect(parseEnvironment({ TRUST_PROXY: 'true' }).TRUST_PROXY).toBe(true);
    expect(() => parseEnvironment({ TRUST_PROXY: '1' })).toThrow();
  });

  it('allows only HTTPS or local HTTP addon URLs', () => {
    expect(() => parseEnvironment({ ADDON_BASE_URL: 'http://public.example' })).toThrow();
    expect(parseEnvironment({ ADDON_BASE_URL: 'https://addon.example/base/' }).ADDON_BASE_URL).toBe(
      'https://addon.example/base/',
    );
  });

  it('parses an explicit Indexers origin allowlist', () => {
    expect(
      parseEnvironment({
        INDEXER_ALLOWED_ORIGINS: 'https://indexers.example, http://prowlarr:9696',
      }).INDEXER_ALLOWED_ORIGINS,
    ).toEqual(['https://indexers.example', 'http://prowlarr:9696']);
  });
});
