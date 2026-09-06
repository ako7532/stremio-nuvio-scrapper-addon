import * as cheerio from 'cheerio';

import {
  absoluteSktorrentUrl,
  assertSktorrentPage,
  normalizeWhitespace,
  parseFlagLanguage,
  parseNonNegativeInteger,
  parseSizeBytes,
} from './sktorrent-parser-utils.js';
import type { SktorrentDetail, SktorrentFile } from './sktorrent-types.js';
import { SktorrentParserError } from './sktorrent-types.js';

const ID_PATTERN = /(?:^|[?&])id=([a-f\d]{40})(?:&|$)/iu;
const PEERS_PATTERN = /Seed:\s*(\d+)\s*,\s*Leech:\s*(\d+)/iu;

export const parseSktorrentDetail = (html: string, providerUrl: string): SktorrentDetail => {
  const $ = cheerio.load(html);
  assertSktorrentPage($, 'detail');

  const normalizedProviderUrl = absoluteSktorrentUrl(providerUrl);
  if (new URL(normalizedProviderUrl).pathname !== '/torrent/details.php') {
    throw new SktorrentParserError(`Unexpected SKTorrent detail URL: ${providerUrl}`);
  }
  const downloadLink = $('a[href^="download.php?id="]').first();
  const downloadPath = downloadLink.attr('href');
  const id =
    downloadPath === undefined ? undefined : ID_PATTERN.exec(downloadPath)?.[1]?.toLowerCase();
  const title = labeledValue($, 'Názov:');
  const categoryCell = labeledCell($, 'Kategória:');
  const peerMatch = PEERS_PATTERN.exec(labeledValue($, 'Peerov:'));

  if (downloadPath === undefined || id === undefined || peerMatch === null) {
    throw new SktorrentParserError(
      'SKTorrent detail page is missing torrent identity or peer counts',
    );
  }
  const providerId = new URL(normalizedProviderUrl).searchParams.get('id')?.toLowerCase();
  if (providerId !== id) {
    throw new SktorrentParserError('SKTorrent detail URL and download identity do not match');
  }

  const description = $('meta[itemprop="description"]').attr('content') ?? '';
  const declaredLanguage = /^Jazyk:\s*([^\r\n]+)/imu.exec(description)?.[1]?.trim();
  const declaredSubtitles = /^Titulky:\s*([^\r\n]+)/imu.exec(description)?.[1]?.trim();
  const mediaInfo = extractMediaInfo(description);
  const genre = optionalLabeledValue($, 'Zaner:');

  return {
    id,
    title,
    category: categoryCell
      .clone()
      .find('img')
      .remove()
      .end()
      .text()
      .replace(/\s*-\s*$/u, '')
      .trim(),
    language: parseFlagLanguage(categoryCell.find('img[src*="/flag/"]').attr('src')),
    sizeBytes: parseSizeBytes(labeledValue($, 'Velikost:'), 'detail size'),
    addedDate: labeledValue($, 'Pridaný:'),
    seeders: parseNonNegativeInteger(peerMatch[1] ?? '', 'detail seeders'),
    leechers: parseNonNegativeInteger(peerMatch[2] ?? '', 'detail leechers'),
    ...(genre === undefined ? {} : { genre }),
    files: parseFiles($),
    ...(declaredLanguage === undefined ? {} : { declaredLanguage }),
    ...(declaredSubtitles === undefined ? {} : { declaredSubtitles }),
    ...(mediaInfo === undefined ? {} : { mediaInfo }),
    downloadPath,
    providerUrl: normalizedProviderUrl,
  };
};

const labeledCell = (root: cheerio.CheerioAPI, label: string) => {
  const labelCell = root('td')
    .filter((_index, cell) => normalizeWhitespace(root(cell).text()) === label)
    .first();
  const valueCell = labelCell.next('td');
  if (labelCell.length === 0 || valueCell.length === 0) {
    throw new SktorrentParserError(`SKTorrent detail page is missing ${label}`);
  }
  return valueCell;
};

const labeledValue = (root: cheerio.CheerioAPI, label: string): string => {
  const value = normalizeWhitespace(labeledCell(root, label).text());
  if (value.length === 0) {
    throw new SktorrentParserError(`SKTorrent detail field ${label} is empty`);
  }
  return value;
};

const optionalLabeledValue = (root: cheerio.CheerioAPI, label: string): string | undefined => {
  try {
    return labeledValue(root, label);
  } catch (error) {
    if (error instanceof SktorrentParserError) {
      return undefined;
    }
    throw error;
  }
};

const parseFiles = (root: cheerio.CheerioAPI): readonly SktorrentFile[] => {
  const files: SktorrentFile[] = [];
  root('#files table tr')
    .slice(1)
    .each((_index, row) => {
      const cells = root(row).find('td');
      const name = normalizeWhitespace(cells.eq(0).text());
      const size = normalizeWhitespace(cells.eq(1).text());
      if (name.length > 0 && size.length > 0) {
        files.push({ name, sizeBytes: parseSizeBytes(size, 'file size') });
      }
    });

  if (files.length === 0) {
    throw new SktorrentParserError('SKTorrent detail page contains no recognizable files');
  }
  return files;
};

const extractMediaInfo = (description: string): string | undefined => {
  const markerIndex = description.search(/-\s*Mediainfo/iu);
  if (markerIndex < 0) {
    return undefined;
  }
  const value = description
    .slice(markerIndex)
    .replace(/^.*?-\s*Mediainfo\s*/iu, '')
    .trim();
  return value.length === 0 ? undefined : value;
};
