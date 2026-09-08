import type { UserConfiguration } from './configuration.js';
import { rankingFactors } from './configuration.js';
import { dynamicRanges, resolutions, sourceTypes, videoCodecs } from './release.js';

export const defaultConfiguration = (): UserConfiguration => ({
  general: { metadataLanguage: 'sk-SK' },
  providers: {
    sktorrent: { enabled: true, playbackMode: 'direct-torrent' },
    webshare: { enabled: true },
    indexers: { enabled: false, backend: 'prowlarr', selectedIndexerIds: [] },
  },
  filters: {
    resolutions: [...resolutions],
    sources: [...sourceTypes],
    videoCodecs: [...videoCodecs],
    dynamicRanges: [...dynamicRanges],
    minimumSeeders: 0,
    includeTerms: [],
    excludeTerms: [],
  },
  languages: {
    mode: 'fallback',
    audio: { preferred: ['sk', 'cs'], allowed: ['en'], excluded: [] },
    subtitles: { preferred: ['sk', 'cs'], allowed: ['en'], excluded: [] },
  },
  ranking: [...rankingFactors],
  limits: { total: 20, perResolution: {} },
  torbox: { showUncached: false, precacheCount: 0 },
  display: { mode: 'detailed' },
  advanced: { providerTimeoutMs: 8_000, safeDebug: false },
});
