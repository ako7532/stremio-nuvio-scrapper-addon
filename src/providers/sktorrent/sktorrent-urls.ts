import { absoluteSktorrentUrl } from './sktorrent-parser-utils.js';
import { SktorrentParserError } from './sktorrent-types.js';

const SKTORRENT_LISTING_URL = 'https://sktorrent.eu/torrent/torrents_v2.php';
const DETAIL_ID_PATTERN = /^[a-f\d]{40}$/u;
const READ_ONLY_PAGE_PATHS = new Set(['/torrent/torrents_v2.php', '/torrent/details.php']);

export const buildSktorrentListingUrl = (query: string, page = 0): string => {
  const normalizedQuery = query.trim();
  if (normalizedQuery.length === 0) {
    throw new SktorrentParserError('SKTorrent search query must not be empty');
  }
  if (!Number.isSafeInteger(page) || page < 0) {
    throw new SktorrentParserError(`Invalid SKTorrent listing page: ${String(page)}`);
  }

  const url = new URL(SKTORRENT_LISTING_URL);
  url.search = new URLSearchParams({
    search: normalizedQuery,
    category: '0',
    active: '0',
    order: 'data',
    by: 'DESC',
    page: String(page),
  }).toString();
  return url.toString();
};

export const normalizeSktorrentDetailUrl = (value: string): string => {
  const normalizedUrl = absoluteSktorrentUrl(value);
  const url = new URL(normalizedUrl);
  const id = url.searchParams.get('id');
  if (url.pathname !== '/torrent/details.php' || id === null || !DETAIL_ID_PATTERN.test(id)) {
    throw new SktorrentParserError(`Unexpected SKTorrent detail URL: ${value}`);
  }
  return normalizedUrl;
};

export const normalizeSktorrentReadOnlyPageUrl = (value: string): string => {
  const normalizedUrl = absoluteSktorrentUrl(value);
  const url = new URL(normalizedUrl);
  if (
    url.username.length > 0 ||
    url.password.length > 0 ||
    !READ_ONLY_PAGE_PATHS.has(url.pathname)
  ) {
    throw new SktorrentParserError(`Unexpected SKTorrent read-only page URL: ${value}`);
  }
  return normalizedUrl;
};

export const normalizeSktorrentDownloadUrl = (
  value: string,
  expectedProviderId: string,
): string => {
  const normalizedUrl = absoluteSktorrentUrl(value);
  const url = new URL(normalizedUrl);
  const id = url.searchParams.get('id')?.toLowerCase();
  if (
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.pathname !== '/torrent/download.php' ||
    id !== expectedProviderId.toLowerCase() ||
    !DETAIL_ID_PATTERN.test(id)
  ) {
    throw new SktorrentParserError(`Unexpected SKTorrent download URL: ${value}`);
  }
  return normalizedUrl;
};
