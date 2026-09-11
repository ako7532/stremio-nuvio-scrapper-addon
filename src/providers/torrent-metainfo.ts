import { createHash } from 'node:crypto';

const MAXIMUM_BENCODE_DEPTH = 64;

export class TorrentMetainfoError extends Error {
  override readonly name = 'TorrentMetainfoError';
}

export const calculateV1InfoHash = (torrent: Uint8Array): string => {
  const bytes = Buffer.from(torrent.buffer, torrent.byteOffset, torrent.byteLength);
  const infoRange = findInfoDictionary(bytes);
  return createHash('sha1').update(bytes.subarray(infoRange.start, infoRange.end)).digest('hex');
};

const findInfoDictionary = (bytes: Buffer): { start: number; end: number } => {
  if (bytes[0] !== 0x64) throw invalidTorrent();
  let cursor = 1;
  let infoRange: { start: number; end: number } | undefined;
  while (bytes[cursor] !== 0x65) {
    const key = readString(bytes, cursor);
    const valueStart = key.end;
    const valueEnd = skipValue(bytes, valueStart, 1);
    if (bytes.subarray(key.start, key.end).equals(Buffer.from('info'))) {
      if (infoRange !== undefined || bytes[valueStart] !== 0x64) throw invalidTorrent();
      infoRange = { start: valueStart, end: valueEnd };
    }
    cursor = valueEnd;
  }
  if (cursor + 1 !== bytes.length || infoRange === undefined) throw invalidTorrent();
  return infoRange;
};

const skipValue = (bytes: Buffer, offset: number, depth: number): number => {
  if (depth > MAXIMUM_BENCODE_DEPTH || offset >= bytes.length) throw invalidTorrent();
  const marker = bytes[offset];
  if (marker !== undefined && marker >= 0x30 && marker <= 0x39) {
    return readString(bytes, offset).end;
  }
  if (marker === 0x69) {
    const end = bytes.indexOf(0x65, offset + 1);
    if (end < 0 || !/^-?(?:0|[1-9]\d*)$/u.test(bytes.subarray(offset + 1, end).toString('ascii'))) {
      throw invalidTorrent();
    }
    return end + 1;
  }
  if (marker !== 0x6c && marker !== 0x64) throw invalidTorrent();
  let cursor = offset + 1;
  while (bytes[cursor] !== 0x65) {
    if (marker === 0x64) cursor = readString(bytes, cursor).end;
    cursor = skipValue(bytes, cursor, depth + 1);
  }
  return cursor + 1;
};

const readString = (bytes: Buffer, offset: number): { start: number; end: number } => {
  const colon = bytes.indexOf(0x3a, offset);
  if (colon < 0) throw invalidTorrent();
  const lengthText = bytes.subarray(offset, colon).toString('ascii');
  if (!/^(?:0|[1-9]\d*)$/u.test(lengthText)) throw invalidTorrent();
  const length = Number.parseInt(lengthText, 10);
  const start = colon + 1;
  const end = start + length;
  if (!Number.isSafeInteger(length) || end > bytes.length) throw invalidTorrent();
  return { start, end };
};

const invalidTorrent = (): TorrentMetainfoError =>
  new TorrentMetainfoError('Invalid torrent metainfo');
