import { describe, expect, it } from 'vitest';

import type { MediaMetadata } from '../../src/domain/media.js';
import { matchMovie } from '../../src/matching/movie-matcher.js';

const metadata: MediaMetadata = {
  type: 'movie',
  id: 'tt1160419',
  originalTitle: 'Dune',
  czechTitle: 'Duna',
  alternativeTitles: [],
  year: 2021,
};

describe('movie matcher', () => {
  it('accepts an exact localized title and matching year', () => {
    expect(
      matchMovie(metadata, {
        mediaType: 'movie',
        title: 'Duna',
        releaseName: 'Duna.2021.1080p.WEB-DL',
      }),
    ).toMatchObject({ matched: true, score: 90 });
  });

  it('rejects the wrong year even when the title matches', () => {
    expect(
      matchMovie(metadata, {
        mediaType: 'movie',
        title: 'Dune',
        releaseName: 'Dune.1984.1080p.BluRay',
      }),
    ).toMatchObject({
      matched: false,
      score: 30,
      reasons: ['exact provider title', 'year mismatch'],
    });
  });

  it('rejects sequels that merely start with the requested title', () => {
    expect(
      matchMovie(metadata, {
        mediaType: 'movie',
        title: 'Dune Part Two',
        releaseName: 'Dune.Part.Two.2024.1080p.WEB-DL',
      }),
    ).toMatchObject({ matched: false, reasons: ['title mismatch'] });
  });

  it('uses the release filename to reject a sequel even when the provider title is misleading', () => {
    expect(
      matchMovie(metadata, {
        mediaType: 'movie',
        title: 'Dune',
        releaseName: 'Dune.Part.Two.2021.1080p.WEB-DL',
      }),
    ).toMatchObject({ matched: false, reasons: ['title mismatch'] });
  });

  it.each(['sample', 'trailer', 'soundtrack', 'extras'])('rejects %s content', (kind) => {
    expect(
      matchMovie(metadata, {
        mediaType: 'movie',
        title: 'Dune',
        releaseName: `Dune.2021.${kind}.1080p`,
      }).matched,
    ).toBe(false);
  });

  it('rejects subtitle files and the wrong media type', () => {
    expect(
      matchMovie(metadata, {
        mediaType: 'movie',
        title: 'Dune',
        releaseName: 'Dune.2021',
        filename: 'Dune.cs.srt',
      }).matched,
    ).toBe(false);
    expect(
      matchMovie(metadata, {
        mediaType: 'series',
        title: 'Dune',
        releaseName: 'Dune.S01E01',
      }).matched,
    ).toBe(false);
  });
});
