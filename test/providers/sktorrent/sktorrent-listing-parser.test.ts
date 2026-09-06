import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { parseSktorrentListing } from '../../../src/providers/sktorrent/sktorrent-listing-parser.js';

const fixture = await readFile(
  new URL('../../fixtures/sktorrent/listing.html', import.meta.url),
  'utf8',
);

describe('SKTorrent listing parser', () => {
  it('extracts only fields confirmed by the sanitized listing fixture', () => {
    expect(parseSktorrentListing(fixture)).toEqual([
      {
        id: '1111111111111111111111111111111111111111',
        title: 'Sample seriál S01E04 (2025)(SK)[1080p][WEB-DL]',
        category: 'TV Pořad',
        language: 'sk',
        sizeBytes: 2_500_000_000,
        addedDate: '2026-09-03',
        seeders: 34,
        leechers: 2,
        detailUrl:
          'https://sktorrent.eu/torrent/details.php?name=Sample-Series-S01E04&id=1111111111111111111111111111111111111111',
      },
      {
        id: '2222222222222222222222222222222222222222',
        title: 'Ukážkový film (2024)(CZ)[720p]',
        category: 'Filmy CZ/SK dabing',
        language: 'cs',
        sizeBytes: 750_000_000,
        addedDate: '2026-09-01',
        seeders: 7,
        leechers: 0,
        detailUrl:
          'https://sktorrent.eu/torrent/details.php?name=Sample-Movie&id=2222222222222222222222222222222222222222',
      },
    ]);
  });

  it('fails clearly when the listing structure no longer has result cards', () => {
    expect(() =>
      parseSktorrentListing('<html lang="sk"><table class="lista"></table></html>'),
    ).toThrow('SKTorrent listing contains no recognizable result cards');
  });

  it('returns an empty result for the observed no-results marker', () => {
    const emptyPage = `
      <html lang="sk"><body><table class="lista">
        <tr><td><a href="index.php">Nenasli ste co ste hladali???...Napiste nam to na nastenku</a></td></tr>
      </table></body></html>`;

    expect(parseSktorrentListing(emptyPage)).toEqual([]);
  });

  it('fails clearly when a recognized card loses a required field', () => {
    const malformed = fixture.replace('Velkost 2.5 GB', 'Size unavailable');
    expect(() => parseSktorrentListing(malformed)).toThrow(
      'SKTorrent listing card 1111111111111111111111111111111111111111 is missing required fields',
    );
  });
});
