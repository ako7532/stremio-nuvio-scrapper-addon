import { describe, expect, it } from 'vitest';

import { normalizeTitle, titleTokens } from '../../src/metadata/title-normalizer.js';

describe('title normalization', () => {
  it('removes Czech and Slovak diacritics and release punctuation', () => {
    expect(normalizeTitle('  Červený.kapitán: Návrat!  ')).toBe('cerveny kapitan navrat');
  });

  it('transliterates Latin characters that do not decompose', () => {
    expect(normalizeTitle("L'œuvre & Łódź")).toBe('loeuvre lodz');
  });

  it('returns stable tokens for matching', () => {
    expect(titleTokens('Spider-Man: No Way Home')).toEqual(['spider', 'man', 'no', 'way', 'home']);
    expect(titleTokens('')).toEqual([]);
  });
});
