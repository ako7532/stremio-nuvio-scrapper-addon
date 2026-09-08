export class TorrentIdentityError extends Error {
  override readonly name = 'TorrentIdentityError';

  constructor(
    readonly kind: 'invalid' | 'conflict' | 'unsupported-v2',
    message: string,
  ) {
    super(message);
  }
}

export type V1TorrentIdentity = { kind: 'btih'; infoHash: string };

export const normalizeBtih = (value: string): string => {
  const normalized = value.trim();
  if (/^[a-f\d]{40}$/iu.test(normalized)) return normalized.toLowerCase();
  if (/^[a-z2-7]{32}$/iu.test(normalized)) {
    return Buffer.from(decodeBase32(normalized)).toString('hex');
  }
  if (/^[a-f\d]{64}$/iu.test(normalized) || normalized.toLowerCase().startsWith('urn:btmh:')) {
    throw new TorrentIdentityError('unsupported-v2', 'BitTorrent v2 identity is unsupported');
  }
  throw new TorrentIdentityError('invalid', 'BitTorrent v1 identity is invalid');
};

export const identityFromMagnet = (value: string): V1TorrentIdentity => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TorrentIdentityError('invalid', 'Magnet URI is invalid');
  }
  if (url.protocol !== 'magnet:') {
    throw new TorrentIdentityError('invalid', 'Torrent acquisition URI is not a magnet');
  }
  const exactTopics = url.searchParams.getAll('xt');
  const v1 = exactTopics
    .filter((topic) => topic.toLowerCase().startsWith('urn:btih:'))
    .map((topic) => normalizeBtih(topic.slice('urn:btih:'.length)));
  if (v1.length === 0) {
    if (exactTopics.some((topic) => topic.toLowerCase().startsWith('urn:btmh:'))) {
      throw new TorrentIdentityError('unsupported-v2', 'BitTorrent v2 magnet is unsupported');
    }
    throw new TorrentIdentityError('invalid', 'Magnet URI has no BitTorrent v1 identity');
  }
  if (new Set(v1).size !== 1) {
    throw new TorrentIdentityError('conflict', 'Magnet URI contains conflicting identities');
  }
  return { kind: 'btih', infoHash: v1[0] ?? '' };
};

export const resolveV1TorrentIdentity = (input: {
  declaredInfoHash?: string;
  magnetUri?: string;
}): V1TorrentIdentity | undefined => {
  const declared =
    input.declaredInfoHash === undefined ? undefined : normalizeBtih(input.declaredInfoHash);
  const magnet = input.magnetUri === undefined ? undefined : identityFromMagnet(input.magnetUri);
  if (declared !== undefined && magnet !== undefined && declared !== magnet.infoHash) {
    throw new TorrentIdentityError('conflict', 'Declared and magnet identities conflict');
  }
  const infoHash = declared ?? magnet?.infoHash;
  return infoHash === undefined ? undefined : { kind: 'btih', infoHash };
};

const decodeBase32 = (value: string): Uint8Array => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const output = new Uint8Array(20);
  let buffer = 0;
  let bits = 0;
  let offset = 0;
  for (const character of value.toUpperCase()) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) throw new TorrentIdentityError('invalid', 'Base32 identity is invalid');
    buffer = (buffer << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      output[offset++] = (buffer >>> bits) & 0xff;
      buffer &= (1 << bits) - 1;
    }
  }
  if (offset !== output.length || bits !== 0) {
    throw new TorrentIdentityError('invalid', 'Base32 identity has an invalid length');
  }
  return output;
};
