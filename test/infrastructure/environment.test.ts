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
      SCRAPE_PROWLARR: false,
      PROWLARR_INDEXERS: [],
      SCRAPE_JACKETT: false,
      JACKETT_INDEXERS: [],
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

  it('parses server-managed Prowlarr and Jackett settings', () => {
    const environment = parseEnvironment({
      SCRAPE_PROWLARR: 'true',
      PROWLARR_API_KEY: 'server-held-prowlarr-key',
      PROWLARR_INDEXERS: '["public-one","public-two"]',
      SCRAPE_JACKETT: 'True',
      JACKETT_API_KEY: 'server-held-jackett-key',
    });

    expect(environment.SCRAPE_PROWLARR).toBe(true);
    expect(environment.PROWLARR_INDEXERS).toEqual(['public-one', 'public-two']);
    expect(environment.SCRAPE_JACKETT).toBe(true);
    expect(environment.JACKETT_INDEXERS).toEqual([]);
  });

  it('requires credentials for enabled server-managed backends', () => {
    expect(() => parseEnvironment({ SCRAPE_PROWLARR: 'true' })).toThrow();
    expect(() => parseEnvironment({ SCRAPE_JACKETT: 'true' })).toThrow();
    expect(() => parseEnvironment({ PROWLARR_INDEXERS: 'not-json' })).toThrow();
    expect(() => parseEnvironment({ PROWLARR_INDEXERS: '["duplicate","duplicate"]' })).toThrow();
  });

  it('accepts empty server credentials while their backends are disabled', () => {
    expect(parseEnvironment({ PROWLARR_API_KEY: '', JACKETT_API_KEY: '' })).toMatchObject({
      SCRAPE_PROWLARR: false,
      PROWLARR_API_KEY: undefined,
      SCRAPE_JACKETT: false,
      JACKETT_API_KEY: undefined,
    });
  });
});
