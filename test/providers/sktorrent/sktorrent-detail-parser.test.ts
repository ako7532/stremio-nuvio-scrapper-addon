import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { parseSktorrentDetail } from '../../../src/providers/sktorrent/sktorrent-detail-parser.js';

const fixture = await readFile(
  new URL('../../fixtures/sktorrent/detail.html', import.meta.url),
  'utf8',
);

describe('SKTorrent detail parser', () => {
  it('extracts fixture-backed detail fields without asserting an info hash or magnet', () => {
    const detail = parseSktorrentDetail(
      fixture,
      'details.php?id=1111111111111111111111111111111111111111',
    );

    expect(detail).toEqual({
      id: '1111111111111111111111111111111111111111',
      title: 'Sample seriál S01E04 (2025)(SK)[1080p][WEB-DL]',
      category: 'TV Pořad',
      language: 'sk',
      sizeBytes: 2_500_000_000,
      addedDate: '2026-09-03',
      seeders: 34,
      leechers: 2,
      genre: 'Reality-TV',
      files: [{ name: 'Sample Series - S01E04.mp4', sizeBytes: 2_500_000_000 }],
      declaredLanguage: 'SK',
      declaredSubtitles: 'CZ, EN',
      mediaInfo:
        'Video\nFormát : AVC\nŠířka : 1 920 pixels\nVýška : 1 080 pixels\n\nAudio\nFormát : AAC LC\nJazyk : Slovak',
      downloadPath:
        'download.php?id=1111111111111111111111111111111111111111&f=sample.torrent&seed=0',
      providerUrl:
        'https://sktorrent.eu/torrent/details.php?id=1111111111111111111111111111111111111111',
    });
    expect(detail).not.toHaveProperty('infoHash');
    expect(detail).not.toHaveProperty('magnetUri');
  });

  it('fails clearly when the file-list invariant disappears', () => {
    const malformed = fixture.replace('id="files"', 'id="files-removed"');
    expect(() =>
      parseSktorrentDetail(malformed, 'details.php?id=1111111111111111111111111111111111111111'),
    ).toThrow('SKTorrent detail page contains no recognizable files');
  });

  it('fails clearly when the provider page is not recognizable', () => {
    expect(() => parseSktorrentDetail('<html></html>', 'details.php?id=ignored')).toThrow(
      'SKTorrent detail page structure is not recognized',
    );
  });

  it('rejects a detail URL from another origin', () => {
    expect(() =>
      parseSktorrentDetail(
        fixture,
        'https://example.com/torrent/details.php?id=1111111111111111111111111111111111111111',
      ),
    ).toThrow('Unexpected SKTorrent URL');
  });

  it('rejects a mismatch between the detail and download identifiers', () => {
    expect(() =>
      parseSktorrentDetail(fixture, 'details.php?id=2222222222222222222222222222222222222222'),
    ).toThrow('SKTorrent detail URL and download identity do not match');
  });
});
