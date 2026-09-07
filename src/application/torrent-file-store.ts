export type TorrentFileStore = {
  put(namespace: string, infoHash: string, file: Uint8Array): void;
  get(namespace: string, infoHash: string): Uint8Array | undefined;
  deleteNamespace(namespace: string): void;
};

export type TorrentFileStoreOptions = {
  ttlMs?: number;
  maximumEntries?: number;
  maximumBytes?: number;
  clock?: () => number;
};

type StoredFile = {
  namespace: string;
  bytes: Uint8Array;
  expiresAt: number;
};

const DEFAULT_TTL_MS = 10 * 60_000;
const DEFAULT_MAXIMUM_ENTRIES = 500;
const DEFAULT_MAXIMUM_BYTES = 32 * 1024 * 1024;
const INFO_HASH = /^[a-f\d]{40}$/u;

export const createTorrentFileStore = (options: TorrentFileStoreOptions = {}): TorrentFileStore => {
  const ttlMs = positiveInteger(options.ttlMs ?? DEFAULT_TTL_MS, 'torrent file TTL');
  const maximumEntries = positiveInteger(
    options.maximumEntries ?? DEFAULT_MAXIMUM_ENTRIES,
    'maximum torrent files',
  );
  const maximumBytes = positiveInteger(
    options.maximumBytes ?? DEFAULT_MAXIMUM_BYTES,
    'maximum torrent file bytes',
  );
  const clock = options.clock ?? Date.now;
  const files = new Map<string, StoredFile>();
  let storedBytes = 0;

  const remove = (key: string): void => {
    const existing = files.get(key);
    if (existing === undefined) return;
    storedBytes -= existing.bytes.byteLength;
    files.delete(key);
  };

  const prune = (): void => {
    const now = clock();
    for (const [key, value] of files) if (value.expiresAt <= now) remove(key);
  };

  return {
    put(namespace, infoHash, file) {
      const normalizedNamespace = requiredNamespace(namespace);
      const hash = normalizeInfoHash(infoHash);
      if (file.byteLength === 0 || file.byteLength > maximumBytes) return;
      prune();
      const key = storeKey(normalizedNamespace, hash);
      remove(key);
      while (
        files.size >= maximumEntries ||
        (storedBytes + file.byteLength > maximumBytes && files.size > 0)
      ) {
        const oldest = files.keys().next().value;
        if (oldest === undefined) break;
        remove(oldest);
      }
      const bytes = file.slice();
      files.set(key, { namespace: normalizedNamespace, bytes, expiresAt: clock() + ttlMs });
      storedBytes += bytes.byteLength;
    },
    get(namespace, infoHash) {
      prune();
      const value = files.get(storeKey(requiredNamespace(namespace), normalizeInfoHash(infoHash)));
      return value?.bytes.slice();
    },
    deleteNamespace(namespace) {
      const normalizedNamespace = requiredNamespace(namespace);
      for (const [key, value] of files) {
        if (value.namespace === normalizedNamespace) remove(key);
      }
    },
  };
};

const storeKey = (namespace: string, infoHash: string): string => `${namespace}\u0000${infoHash}`;

const requiredNamespace = (value: string): string => {
  if (value.length === 0) throw new TypeError('Torrent file namespace is required');
  return value;
};

const normalizeInfoHash = (value: string): string => {
  const normalized = value.trim().toLowerCase();
  if (!INFO_HASH.test(normalized)) throw new TypeError('Invalid torrent file info hash');
  return normalized;
};

const positiveInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be positive`);
  return value;
};
