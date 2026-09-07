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

  it('distinguishes a number in the movie title from the release year', () => {
    const numberedTitle: MediaMetadata = {
      type: 'movie',
      id: 'tt1856101',
      originalTitle: 'Blade Runner 2049',
      alternativeTitles: ['Blade Runner 2'],
      year: 2017,
    };

    expect(
      matchMovie(numberedTitle, {
        mediaType: 'movie',
        title: 'Blade Runner 2049 (2017)',
        releaseName: 'Blade Runner 2049 (2017) 2160p BluRay HEVC',
      }),
    ).toMatchObject({ matched: true, score: 80, reasons: ['exact release title', 'year match'] });
    expect(
      matchMovie(numberedTitle, {
        mediaType: 'movie',
        title: 'Blade Runner 2049 (1982)',
        releaseName: 'Blade Runner 2049 (1982) 1080p BluRay',
      }),
    ).toMatchObject({ matched: false, reasons: ['exact release title', 'year mismatch'] });
    expect(
      matchMovie(numberedTitle, {
        mediaType: 'movie',
        title: 'Blade-Runner2049(2017).mp4',
        releaseName: 'Blade-Runner2049(2017).mp4',
      }),
    ).toMatchObject({ matched: true, reasons: ['exact release title', 'year match'] });
  });

  it.each([
    { title: '1917', releaseYear: 2019 },
    { title: '2001: A Space Odyssey', releaseYear: 1968 },
  ])('handles a year-like number in $title', ({ title, releaseYear }) => {
    expect(
      matchMovie(
        {
          type: 'movie',
          id: 'tt-numbered-title',
          originalTitle: title,
          alternativeTitles: [],
          year: releaseYear,
        },
        {
          mediaType: 'movie',
          title: `${title} (${String(releaseYear)})`,
          releaseName: `${title} (${String(releaseYear)}) 1080p BluRay`,
        },
      ),
    ).toMatchObject({ matched: true, reasons: ['exact release title', 'year match'] });
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

  it('does not treat a slash-separated sequel as a localized title pair', () => {
    expect(
      matchMovie(metadata, {
        mediaType: 'movie',
        title: 'Duna / Dune Part Two',
        releaseName: 'Duna / Dune Part Two 2024 1080p WEB-DL',
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
