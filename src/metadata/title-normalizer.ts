const specialLatinCharacters: Readonly<Record<string, string>> = {
  æ: 'ae',
  đ: 'd',
  ð: 'd',
  ł: 'l',
  ø: 'o',
  œ: 'oe',
  ß: 'ss',
  þ: 'th',
};

export function normalizeTitle(value: string): string {
  const transliterated = Array.from(value.toLocaleLowerCase('en-US'))
    .map((character) => specialLatinCharacters[character] ?? character)
    .join('');

  return transliterated
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[’']/gu, '')
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .trim()
    .replace(/\s+/gu, ' ');
}

export function titleTokens(value: string): readonly string[] {
  const normalized = normalizeTitle(value);
  return normalized === '' ? [] : normalized.split(' ');
}
