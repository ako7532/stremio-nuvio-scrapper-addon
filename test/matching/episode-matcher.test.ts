import { describe, expect, it } from 'vitest';

import type { MediaMetadata } from '../../src/domain/media.js';
import {
  matchEpisode,
  parseEpisodeCoverage,
  releaseCoversSeason,
} from '../../src/matching/episode-matcher.js';

const metadata: MediaMetadata = {
  type: 'series',
  id: 'tt5753856',
  originalTitle: 'Dark',
  alternativeTitles: [],
  season: 1,
  episode: 4,
  year: 2017,
};

describe('episode matcher', () => {
  it('accepts the requested single episode', () => {
    expect(
      matchEpisode(metadata, {
        mediaType: 'series',
        title: 'Dark',
        releaseName: 'Dark.S01E04.1080p.WEB-DL',
      }),
    ).toMatchObject({ matched: true, score: 100, kind: 'single-episode' });
  });

  it('accepts a localized and original title pair separated by a slash', () => {
    expect(
      matchEpisode(
        {
          ...metadata,
          originalTitle: 'Breaking Bad',
          czechTitle: 'Perníkový táta',
          episode: 1,
        },
        {
          mediaType: 'series',
          title: 'Perníkový táta / Breaking Bad S01E01 - Pilot',
          releaseName: 'Perníkový táta / Breaking Bad S01E01 - Pilot (2008)(CZ/EN)[1080p]',
          filename: '01 Pilot.mkv',
        },
      ),
    ).toMatchObject({ matched: true, kind: 'single-episode' });
  });

  it.each([
    'Hells.Paradise.S02E09.1080p.WEB-DL',
    'Hell.s.Paradise.S02E09.1080p.WEB-DL',
    'Jigokuraku.S02E09.1080p.WEB-DL',
    'Hell.s.Paradise.Jigokuraku.S02E09.1080p.WEB-DL',
  ])('accepts strict English and romanized anime aliases: %s', (releaseName) => {
    expect(
      matchEpisode(
        {
          type: 'series',
          id: 'tt13911284',
          originalTitle: '地獄楽',
          englishTitle: "Hell's Paradise",
          czechTitle: 'Pekelný ráj',
          alternativeTitles: ['Jigokuraku', "Hell's Paradise: Jigokuraku"],
          season: 2,
          episode: 9,
        },
        { mediaType: 'series', title: releaseName, releaseName },
      ),
    ).toMatchObject({ matched: true, kind: 'single-episode' });
  });

  it('does not treat a bare absolute anime episode number as episode coverage', () => {
    expect(parseEpisodeCoverage('Jigokuraku - 22 (1080p)')).toBeUndefined();
  });

  it('rejects another episode and another season', () => {
    expect(
      matchEpisode(metadata, {
        mediaType: 'series',
        title: 'Dark',
        releaseName: 'Dark.S01E05.1080p.WEB-DL',
      }),
    ).toMatchObject({ matched: false, reasons: ['episode mismatch'] });
    expect(
      matchEpisode(metadata, {
        mediaType: 'series',
        title: 'Dark',
        releaseName: 'Dark.S02E04.1080p.WEB-DL',
      }),
    ).toMatchObject({ matched: false, reasons: ['season mismatch'] });
  });

  it('accepts multi-episode releases only when they cover the requested episode', () => {
    expect(
      matchEpisode(metadata, {
        mediaType: 'series',
        title: 'Dark',
        releaseName: 'Dark.S01E03E04E05.1080p',
      }),
    ).toMatchObject({ matched: true, kind: 'multi-episode' });
    expect(
      matchEpisode(metadata, {
        mediaType: 'series',
        title: 'Dark',
        releaseName: 'Dark.S01E01-E06.1080p',
      }),
    ).toMatchObject({ matched: true, kind: 'multi-episode' });
  });

  it('accepts matching season packs but not packs for another season', () => {
    expect(
      matchEpisode(metadata, {
        mediaType: 'series',
        title: 'Dark',
        releaseName: 'Dark.S01.Complete.1080p',
      }),
    ).toMatchObject({ matched: true, score: 85, kind: 'season-pack' });
    expect(
      matchEpisode(metadata, {
        mediaType: 'series',
        title: 'Dark',
        releaseName: 'Dark.Season.2.Complete.1080p',
      }).matched,
    ).toBe(false);
  });

  it('accepts localized season packs and multi-season ranges only when they cover the season', () => {
    const complete = {
      mediaType: 'series' as const,
      title: 'Mafstory - 1. - 11. serie',
      releaseName: 'Mafstory - 1. - 11. serie (2006)(SK)[TvRip]',
    };

    expect(
      matchEpisode(
        {
          ...metadata,
          originalTitle: 'Mafstory',
          season: 1,
          episode: 1,
        },
        complete,
      ),
    ).toMatchObject({ matched: true, kind: 'season-pack' });
    expect(
      matchEpisode(
        {
          ...metadata,
          originalTitle: 'Mafstory',
          season: 12,
          episode: 1,
        },
        complete,
      ),
    ).toMatchObject({ matched: false, reasons: ['season mismatch'] });
    expect(parseEpisodeCoverage('Mafstory 7. serie')?.season).toBe(7);
    expect(parseEpisodeCoverage('Mafstory seria 8')?.season).toBe(8);
    expect(releaseCoversSeason('Mafstory - 1. - 11. serie', 1)).toBe(true);
    expect(releaseCoversSeason('Mafstory - 1. - 11. serie', 12)).toBe(false);
  });

  it('requires an explicit episode or pack marker', () => {
    expect(
      matchEpisode(metadata, {
        mediaType: 'series',
        title: 'Dark',
        releaseName: 'Dark.1080p.WEB-DL',
      }),
    ).toMatchObject({ matched: false, reasons: ['episode marker missing'] });
  });
});

describe('episode coverage parsing', () => {
  it('expands common ranges and recognizes alternate notation', () => {
    expect(parseEpisodeCoverage('Show.S01E03-E05')?.episodes).toEqual(new Set([3, 4, 5]));
    expect(parseEpisodeCoverage('Show.1x03-05')?.episodes).toEqual(new Set([3, 4, 5]));
  });
});
