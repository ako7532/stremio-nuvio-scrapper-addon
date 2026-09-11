import { describe, expect, it } from 'vitest';

import { createPlaybackReferenceStore } from '../../src/application/playback-reference-store.js';
import { defaultConfiguration } from '../../src/domain/configuration-defaults.js';
import type { TorrentProviderResult } from '../../src/domain/release.js';

describe('playback reference store', () => {
  it('invalidates every reference owned by a configuration namespace', () => {
    let sequence = 0;
    const store = createPlaybackReferenceStore({
      createId: () => `opaque-reference-${String(++sequence).padStart(4, '0')}`,
    });
    const first = store.put(reference('configuration-one-1234'));
    const second = store.put(reference('configuration-two-1234'));

    store.deleteNamespace('configuration-one-1234');

    expect(store.get(first.id)).toBeUndefined();
    expect(store.get(second.id)).toBeDefined();
  });
});

const reference = (configId: string) => {
  const configuration = defaultConfiguration();
  const result: TorrentProviderResult = {
    provider: 'indexers',
    source: 'torrent',
    id: 'public-fixture:fixture-result',
    title: 'Fixture.Movie.2026.1080p.WEB-DL',
    releaseName: 'Fixture.Movie.2026.1080p.WEB-DL',
    mediaType: 'movie',
    providerUrl: 'https://indexers.invalid/public-fixture',
    infoHash: '1'.repeat(40),
    magnetUri: `magnet:?xt=urn:btih:${'1'.repeat(40)}`,
    cacheStatus: 'unknown',
  };
  return {
    configId,
    result,
    media: { type: 'movie' as const, id: 'tt0000001' },
    allowUncached: false,
    precacheCandidates: [],
    precachePolicy: {
      count: 0,
      minimumMatchScore: 0,
      minimumSeeders: 0,
      allowedResolutions: configuration.filters.resolutions,
      preferredAudioLanguages: configuration.languages.audio.preferred,
      preferredSubtitleLanguages: configuration.languages.subtitles.preferred,
      preferredLanguagesOnly: false,
    },
  };
};
