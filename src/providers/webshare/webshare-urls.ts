const WEBSHARE_ORIGIN = 'https://webshare.cz';
const FILE_ID_PATTERN = /^[A-Za-z0-9]{10}$/u;

export type WebshareApiOperation =
  'salt' | 'login' | 'search' | 'file_info' | 'file_exists' | 'file_link';

export const buildWebshareApiUrl = (operation: WebshareApiOperation): string =>
  `${WEBSHARE_ORIGIN}/api/${operation}/`;

export const normalizeWebshareFileId = (value: string): string => {
  if (!FILE_ID_PATTERN.test(value)) {
    throw new TypeError('Invalid Webshare file identifier');
  }
  return value;
};

export const buildWebshareFileUrl = (fileId: string): string =>
  `${WEBSHARE_ORIGIN}/#/file/${normalizeWebshareFileId(fileId)}`;

export const normalizeWebsharePlaybackUrl = (value: string): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('Webshare returned an invalid playback URL');
  }
  if (url.protocol !== 'https:' || url.username.length > 0 || url.password.length > 0) {
    throw new TypeError('Webshare returned an unsafe playback URL');
  }
  return url.toString();
};
