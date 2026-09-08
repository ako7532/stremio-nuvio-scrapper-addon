import { calculateV1InfoHash, TorrentMetainfoError } from '../torrent-metainfo.js';
import { SktorrentParserError } from './sktorrent-types.js';

const PROVIDER_ID_PATTERN = /^[a-f\d]{40}$/u;

export type SktorrentTorrentMetadata = {
  infoHash: string;
  magnetUri: string;
};

export const parseSktorrentTorrent = (
  torrent: Uint8Array,
  expectedProviderId: string,
): SktorrentTorrentMetadata => {
  const normalizedProviderId = expectedProviderId.toLowerCase();
  if (!PROVIDER_ID_PATTERN.test(normalizedProviderId)) {
    throw new SktorrentParserError(`Invalid SKTorrent provider ID: ${expectedProviderId}`);
  }
  let infoHash: string;
  try {
    infoHash = calculateV1InfoHash(torrent);
  } catch (error) {
    if (error instanceof TorrentMetainfoError) {
      throw new SktorrentParserError('Invalid SKTorrent torrent metadata');
    }
    throw error;
  }
  if (infoHash !== normalizedProviderId) {
    throw new SktorrentParserError('SKTorrent provider ID does not match torrent info hash');
  }
  return { infoHash, magnetUri: `magnet:?xt=urn:btih:${infoHash}` };
};
