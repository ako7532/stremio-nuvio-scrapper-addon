import { describe, expect, it } from 'vitest';

import { createTorrentFileStore } from '../../src/application/torrent-file-store.js';

const hash = (character: string): string => character.repeat(40);

describe('torrent file store', () => {
  it('isolates files by configuration and returns defensive copies', () => {
    const store = createTorrentFileStore();
    const original = Uint8Array.from([1, 2, 3]);
    store.put('configuration-a', hash('a'), original);
    original[0] = 9;

    const stored = store.get('configuration-a', hash('a'));
    expect(stored).toEqual(Uint8Array.from([1, 2, 3]));
    expect(store.get('configuration-b', hash('a'))).toBeUndefined();
    if (stored !== undefined) stored[0] = 8;
    expect(store.get('configuration-a', hash('a'))).toEqual(Uint8Array.from([1, 2, 3]));
  });

  it('expires, evicts, and deletes stored private metadata', () => {
    let now = 0;
    const store = createTorrentFileStore({
      ttlMs: 10,
      maximumEntries: 2,
      maximumBytes: 5,
      clock: () => now,
    });
    store.put('configuration-a', hash('a'), Uint8Array.from([1, 2, 3]));
    store.put('configuration-a', hash('b'), Uint8Array.from([4, 5, 6]));
    expect(store.get('configuration-a', hash('a'))).toBeUndefined();
    expect(store.get('configuration-a', hash('b'))).toBeDefined();

    store.deleteNamespace('configuration-a');
    expect(store.get('configuration-a', hash('b'))).toBeUndefined();

    store.put('configuration-b', hash('c'), Uint8Array.from([7]));
    now = 10;
    expect(store.get('configuration-b', hash('c'))).toBeUndefined();
  });
});
