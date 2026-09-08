import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  parseTorznabCapabilities,
  parseTorznabResults,
  TorznabParserError,
} from '../../../src/providers/indexers/torznab-parser.js';

const fixture = (name: string): Promise<string> =>
  readFile(new URL(`../../fixtures/indexers/${name}`, import.meta.url), 'utf8');

describe('Torznab parser', () => {
  it('parses bounded search capabilities and categories', async () => {
    const capabilities = parseTorznabCapabilities(await fixture('caps.xml'));

    expect(capabilities.limits).toEqual({ maximum: 100, default: 50 });
    expect(capabilities.modes.movie).toEqual({
      available: true,
      supportedParameters: ['q', 'imdbid', 'year'],
    });
    expect(capabilities.categories).toEqual([2000, 2040, 5000]);
  });

  it('normalizes namespaced attributes, acquisition references, and base32 hashes', async () => {
    const results = parseTorznabResults(await fixture('search.xml'), {
      indexerId: 'public-fixture',
      indexerName: 'Public Fixture',
      mediaType: 'movie',
    });

    expect(results).toEqual([
      expect.objectContaining({
        releaseGuid: 'release-1',
        infoHash: 'a'.repeat(40),
        acquisitionReference: 'https://backend.example/download/release-1',
        seeders: 12,
        sizeBytes: 2_147_483_648,
      }),
      expect.objectContaining({
        releaseGuid: 'release-2',
        infoHash: '11'.repeat(20),
        magnetUri: expect.stringMatching(/^magnet:/u) as unknown,
        seeders: 3,
      }),
    ]);
  });

  it('rejects declarations, conflicting attributes, oversized responses, and item overflow', () => {
    expect(() => parseTorznabCapabilities('<!DOCTYPE caps><caps />')).toThrow(TorznabParserError);
    expect(() =>
      parseTorznabResults(
        '<rss xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel><item><title>x</title><torznab:attr name="infohash" value="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"/><torznab:attr name="infohash" value="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"/></item></channel></rss>',
        { indexerId: 'fixture', indexerName: 'Fixture', mediaType: 'movie' },
      ),
    ).toThrow(/conflicts/u);
    expect(() => parseTorznabCapabilities('<caps />', { maximumResponseBytes: 1 })).toThrow(
      /too large/u,
    );
    expect(() =>
      parseTorznabResults(
        '<rss><channel><item><title>one</title></item><item><title>two</title></item></channel></rss>',
        { indexerId: 'fixture', indexerName: 'Fixture', mediaType: 'movie' },
        { maximumItems: 1 },
      ),
    ).toThrow(/too many items/u);
  });
});
