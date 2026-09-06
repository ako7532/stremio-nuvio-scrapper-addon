import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  parseWebshareAvailability,
  parseWebshareFileInfo,
  parseWebsharePlaybackLink,
  parseWebshareSalt,
  parseWebshareSearch,
  parseWebshareToken,
} from '../../../src/providers/webshare/webshare-xml.js';

const fixture = async (name: string): Promise<string> =>
  readFile(new URL(`../../fixtures/webshare/${name}`, import.meta.url), 'utf8');

describe('Webshare XML parser', () => {
  it('parses sanitized public search, file-info, and availability responses', async () => {
    const results = parseWebshareSearch(await fixture('search.xml'));
    const info = parseWebshareFileInfo(await fixture('file-info.xml'), '5m56ZO4cb6');
    const availability = parseWebshareAvailability(await fixture('availability.xml'));

    expect(results).toEqual([
      {
        id: '5m56ZO4cb6',
        name: 'Sintel - Příběh draka (2010) 1080p CZ - (ShortFilm) AppleTV.mp4',
        type: 'mp4',
        sizeBytes: 2_015_084_270,
        passwordProtected: false,
      },
    ]);
    expect(info).toMatchObject({ id: '5m56ZO4cb6', available: true, removed: false });
    expect(availability).toEqual({ exists: true, downloadable: true });
  });

  it('parses sanitized credential-backed authentication and link responses', async () => {
    expect(parseWebshareSalt(await fixture('salt.xml'))).toBe('fixture1');
    expect(parseWebshareToken(await fixture('login.xml'))).toBe('sanitized-session-token');
    expect(parseWebsharePlaybackLink(await fixture('file-link.xml'))).toBe(
      'https://media.example.invalid/sintel',
    );
  });

  it('rejects API errors, invalid flags, duplicate fields, and XML declarations', () => {
    expect(() =>
      parseWebshareAvailability(
        '<response><status>FATAL</status><code>FILE_INFO_FATAL_1</code><message>Missing</message></response>',
      ),
    ).toThrow('Missing');
    expect(() =>
      parseWebshareAvailability(
        '<response><status>OK</status><exists>2</exists><downloadable>1</downloadable></response>',
      ),
    ).toThrow();
    expect(() =>
      parseWebshareAvailability(
        '<response><status>OK</status><exists>1</exists><exists>1</exists><downloadable>1</downloadable></response>',
      ),
    ).toThrow('duplicated');
    expect(() =>
      parseWebshareSearch(
        '<!DOCTYPE response [<!ENTITY x "unsafe">]><response><status>OK</status><total>0</total></response>',
      ),
    ).toThrow('declarations');
  });

  it('classifies documented login failures as authentication errors', () => {
    let error: unknown;
    try {
      parseWebshareToken(
        '<response><status>FATAL</status><code>LOGIN_FATAL_3</code><message>Access denied</message></response>',
      );
    } catch (reason) {
      error = reason;
    }
    expect(error).toMatchObject({ kind: 'authentication', code: 'LOGIN_FATAL_3' });
  });
});
