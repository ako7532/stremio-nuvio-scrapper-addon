export type CacheLookup<Value> = { hit: true; value: Value } | { hit: false };

export type BoundedTtlCache<Key, Value> = {
  get(key: Key): CacheLookup<Value>;
  set(key: Key, value: Value): void;
  clear(): void;
};

export type BoundedTtlCacheOptions = {
  ttlMs: number;
  maximumEntries: number;
  clock?: () => number;
};

type CacheEntry<Value> = {
  value: Value;
  expiresAt: number;
};

export function createBoundedTtlCache<Key, Value>(
  options: BoundedTtlCacheOptions,
): BoundedTtlCache<Key, Value> {
  const ttlMs = positiveInteger(options.ttlMs, 'cache TTL');
  const maximumEntries = positiveInteger(options.maximumEntries, 'maximum cache entries');
  const clock = options.clock ?? Date.now;
  const entries = new Map<Key, CacheEntry<Value>>();

  return {
    get(key) {
      const entry = entries.get(key);
      if (entry === undefined) return { hit: false };
      if (entry.expiresAt <= clock()) {
        entries.delete(key);
        return { hit: false };
      }
      entries.delete(key);
      entries.set(key, entry);
      return { hit: true, value: entry.value };
    },
    set(key, value) {
      const now = clock();
      removeExpired(entries, now);
      entries.delete(key);
      while (entries.size >= maximumEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      entries.set(key, { value, expiresAt: now + ttlMs });
    },
    clear() {
      entries.clear();
    },
  };
}

function removeExpired<Key, Value>(entries: Map<Key, CacheEntry<Value>>, now: number): void {
  for (const [key, entry] of entries) {
    if (entry.expiresAt <= now) entries.delete(key);
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}
