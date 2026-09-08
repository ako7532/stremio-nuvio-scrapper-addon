import { describe, expect, it } from 'vitest';

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
});
