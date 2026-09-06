export const manifest = {
  id: 'community.stremio-nuvio.czsk',
  version: '0.1.0',
  name: 'CZ/SK Streams',
  description: 'Configurable CZ/SK stream results from independent providers.',
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  behaviorHints: {
    configurable: false,
    configurationRequired: false,
  },
} as const;
