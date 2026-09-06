import type {
  AudioCodec,
  DynamicRange,
  LanguageInfo,
  ParsedRelease,
  Resolution,
  SourceType,
  VideoCodec,
} from '../domain/release.js';

type Rule<T> = readonly [value: T, pattern: RegExp];

const resolutionRules: readonly Rule<Resolution>[] = [
  ['2160p', /\b(?:2160p?|4k|uhd)\b/iu],
  ['1440p', /\b1440p?\b/iu],
  ['1080p', /\b1080[pi]?\b/iu],
  ['720p', /\b720[pi]?\b/iu],
  ['576p', /\b576[pi]?\b/iu],
  ['480p', /\b480[pi]?\b/iu],
];

const sourceRules: readonly Rule<SourceType>[] = [
  ['remux', /\bremux\b/iu],
  ['bluray', /\b(?:blu[ ._-]?ray|b[dr]rip)\b/iu],
  ['web-dl', /\bweb[ ._-]?dl\b/iu],
  ['webrip', /\bweb[ ._-]?rip\b/iu],
  ['hdtv', /\bhdtv\b/iu],
  ['dvdrip', /\bdvd[ ._-]?rip\b/iu],
  ['dvd', /\bdvd\b/iu],
  ['cam', /\b(?:hdcam|camrip|cam)\b/iu],
  ['ts', /\b(?:telesync|hdts|ts)\b/iu],
];

const videoCodecRules: readonly Rule<VideoCodec>[] = [
  ['av1', /\bav[ ._-]?1\b/iu],
  ['hevc', /\b(?:hevc|h[ ._-]?265|x265)\b/iu],
  ['avc', /\b(?:avc|h[ ._-]?264|x264)\b/iu],
];

const dynamicRangeRules: readonly Rule<DynamicRange>[] = [
  ['dolby-vision', /\b(?:dolby[ ._-]?vision|dovi)\b/iu],
  ['hdr10-plus', /\bhdr[ ._-]?10\+|\bhdr10plus\b/iu],
  ['hdr10', /\bhdr[ ._-]?10\b/iu],
  ['hlg', /\bhlg\b/iu],
  ['sdr', /\bsdr\b/iu],
];

const audioCodecRules: readonly Rule<AudioCodec>[] = [
  ['truehd', /\btrue[ ._-]?hd\b/iu],
  ['atmos', /\batmos\b/iu],
  ['dts-x', /\bdts[ ._-]?x\b/iu],
  ['dts-hd-ma', /\bdts[ ._-]?hd(?:[ ._-]?ma)?\b/iu],
  ['dts', /\bdts\b/iu],
  ['eac3', /\b(?:e[ ._-]?ac[ ._-]?3|ddp|dd\+)\b/iu],
  ['ac3', /\b(?:ac[ ._-]?3|dolby[ ._-]?digital)\b/iu],
  ['aac', /\baac\b/iu],
];

const languageRules = [
  { code: 'cs', names: '(?:cz|cze|cs|czech|cesk(?:y|e))' },
  { code: 'sk', names: '(?:sk|svk|slovak|slovensk(?:y|e))' },
  { code: 'en', names: '(?:en|eng|english)' },
  { code: 'pl', names: '(?:pl|pol|polish)' },
  { code: 'de', names: '(?:de|ger|deu|german)' },
] as const;

export function parseRelease(...values: readonly (string | undefined)[]): ParsedRelease {
  const input = values.filter((value): value is string => value !== undefined).join(' ');
  const resolution = firstMatch(input, resolutionRules, 'unknown');
  const source = firstMatch(input, sourceRules, 'unknown');
  const videoCodec = firstMatch(input, videoCodecRules, 'unknown');
  const dynamicRange = firstMatch(input, dynamicRangeRules, 'unknown');
  const audioCodecs = parseAudioCodecs(input);
  const languages = parseLanguages(input);
  const audioChannels = /(?:^|[^\d])(7\.1|5\.1|2\.1|2\.0)(?:$|[^\d])/u.exec(input)?.[1];
  const releaseGroup = parseReleaseGroup(input);
  const recognized = [
    resolution !== 'unknown',
    source !== 'unknown',
    videoCodec !== 'unknown',
    dynamicRange !== 'unknown',
    audioCodecs.length > 0,
    languages.audio.length > 0 || languages.subtitles.length > 0,
  ].filter(Boolean).length;

  return {
    resolution,
    source,
    videoCodec,
    dynamicRange,
    audioCodecs: audioCodecs.length === 0 ? ['unknown'] : audioCodecs,
    ...(audioChannels === undefined ? {} : { audioChannels }),
    languages,
    ...(releaseGroup === undefined ? {} : { releaseGroup }),
    confidence: recognized / 6,
  };
}

function firstMatch<T>(input: string, rules: readonly Rule<T>[], fallback: T): T {
  return rules.find(([, pattern]) => pattern.test(input))?.[0] ?? fallback;
}

function allMatches<T>(input: string, rules: readonly Rule<T>[]): readonly T[] {
  return rules.filter(([, pattern]) => pattern.test(input)).map(([value]) => value);
}

function parseAudioCodecs(input: string): readonly AudioCodec[] {
  const matches = allMatches(input, audioCodecRules);
  return matches.includes('dts-hd-ma') || matches.includes('dts-x')
    ? matches.filter((codec) => codec !== 'dts')
    : matches;
}

function parseReleaseGroup(input: string): string | undefined {
  const inputWithoutExtension = input.replace(/\.[A-Za-z0-9]{2,4}$/u, '');
  if (/\b(?:web-dl|blu-ray|dts-hd(?:-ma)?|true-hd|hdr-10)$/iu.test(inputWithoutExtension)) {
    return undefined;
  }
  return /-([A-Za-z0-9][A-Za-z0-9_]{1,30})$/u.exec(inputWithoutExtension)?.[1];
}

function parseLanguages(input: string): LanguageInfo {
  const audio = new Set<string>();
  const subtitles = new Set<string>();
  let explicitMatch = false;
  let inputWithoutSubtitleClaims = input;

  for (const language of languageRules) {
    const subtitlePatterns = [
      new RegExp(`\\b${language.names}[ ._-]*(?:sub(?:s|titles?)?|tit(?:ulky)?)\\b`, 'giu'),
      new RegExp(`\\b(?:sub(?:s|titles?)?|tit(?:ulky)?)[ ._-]*${language.names}\\b`, 'giu'),
    ];
    const audioPatterns = [
      new RegExp(
        `\\b${language.names}[ ._-]*(?:audio|dub(?:bed)?|dabing)\\b(?![ ._-]*(?:sub(?:s|titles?)?|tit(?:ulky)?))`,
        'giu',
      ),
      new RegExp(
        `\\b(?:audio|dub(?:bed)?|dabing)[ ._-]*${language.names}\\b(?![ ._-]*(?:sub(?:s|titles?)?|tit(?:ulky)?))`,
        'giu',
      ),
    ];

    for (const pattern of subtitlePatterns) {
      if (pattern.test(input)) {
        subtitles.add(language.code);
        explicitMatch = true;
        pattern.lastIndex = 0;
        inputWithoutSubtitleClaims = inputWithoutSubtitleClaims.replace(pattern, ' ');
      }
    }
    for (const pattern of audioPatterns) {
      if (pattern.test(input)) {
        audio.add(language.code);
        explicitMatch = true;
      }
    }
  }

  const bareTags = [
    ['cs', /(?:^|[ ._[\]()-])(?:CZ|CZE|CS)(?=$|[ ._[\]()-])/gu],
    ['sk', /(?:^|[ ._[\]()-])(?:SK|SVK)(?=$|[ ._[\]()-])/gu],
    ['en', /(?:^|[ ._[\]()-])(?:EN|ENG)(?=$|[ ._[\]()-])/gu],
  ] as const;

  for (const [code, pattern] of bareTags) {
    if (pattern.test(inputWithoutSubtitleClaims)) {
      audio.add(code);
    }
  }

  return {
    audio: [...audio],
    subtitles: [...subtitles],
    confidence: explicitMatch ? 1 : audio.size > 0 ? 0.65 : 0,
  };
}
