import { describe, expect, it } from 'vitest';

import { parseRelease } from '../../src/release/release-parser.js';

describe('release parser', () => {
  it('prefers specific quality markers and retains multiple audio technologies', () => {
    const parsed = parseRelease(
      'Film.2024.2160p.UHD.BluRay.REMUX.DoVi.HDR10+.HEVC.TrueHD.Atmos.7.1.CZ.DABING.EN.SUB-GROUP.mkv',
    );

    expect(parsed).toMatchObject({
      resolution: '2160p',
      source: 'remux',
      videoCodec: 'hevc',
      dynamicRange: 'dolby-vision',
      audioCodecs: ['truehd', 'atmos'],
      audioChannels: '7.1',
      languages: {
        audio: ['cs'],
        subtitles: ['en'],
        confidence: 1,
      },
      releaseGroup: 'GROUP',
      confidence: 1,
    });
  });

  it('does not treat a subtitle claim as an audio language', () => {
    const parsed = parseRelease('Film.1080p.WEB-DL.CZ.SUB.x264');

    expect(parsed.languages).toEqual({ audio: [], subtitles: ['cs'], confidence: 1 });
  });

  it('recognizes conservative standalone language tags', () => {
    const parsed = parseRelease('Film.720p.WEBRip.CZ.SK.AAC.2.0');

    expect(parsed.languages).toEqual({ audio: ['cs', 'sk'], subtitles: [], confidence: 0.65 });
  });

  it('returns explicit unknown values instead of guessing', () => {
    expect(parseRelease('ordinary filename')).toMatchObject({
      resolution: 'unknown',
      source: 'unknown',
      videoCodec: 'unknown',
      dynamicRange: 'unknown',
      audioCodecs: ['unknown'],
      languages: { audio: [], subtitles: [], confidence: 0 },
      confidence: 0,
    });
  });

  it.each(['FullHD', 'Full HD', 'FHD'])('maps %s to 1080p', (marker) => {
    expect(parseRelease(`Film.${marker}.WEB-DL`).resolution).toBe('1080p');
  });

  it('does not report technical hyphenated tags as release groups', () => {
    expect(parseRelease('Film.1080p.WEB-DL').releaseGroup).toBeUndefined();
    expect(parseRelease('Film.1080p.DTS-HD-MA').audioCodecs).toEqual(['dts-hd-ma']);
  });

  it.each([
    ['WEB-DL', 'web-dl'],
    ['WEBRip', 'webrip'],
    ['Blu-ray', 'bluray'],
    ['DVDRip', 'dvdrip'],
    ['HDTS', 'ts'],
  ] as const)('parses %s as %s', (marker, expected) => {
    expect(parseRelease(`Title.${marker}.1080p`).source).toBe(expected);
  });
});
