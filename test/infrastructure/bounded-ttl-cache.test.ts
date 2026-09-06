import { describe, expect, it } from 'vitest';

import { createBoundedTtlCache } from '../../src/infrastructure/bounded-ttl-cache.js';

describe('bounded TTL cache', () => {
  it('expires entries and evicts the least recently used entry', () => {
    let now = 1_000;
    const cache = createBoundedTtlCache<string, number>({
      ttlMs: 100,
      maximumEntries: 2,
      clock: () => now,
    });
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.get('a')).toEqual({ hit: true, value: 1 });

    cache.set('c', 3);
    expect(cache.get('b')).toEqual({ hit: false });
    expect(cache.get('a')).toEqual({ hit: true, value: 1 });

    now = 1_100;
    expect(cache.get('a')).toEqual({ hit: false });
    expect(cache.get('c')).toEqual({ hit: false });
  });
});
