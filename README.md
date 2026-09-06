# Stremio / Nuvio CZ-SK scraper addon

An early-stage, self-hosted Stremio protocol addon designed to aggregate normalized stream results from SKTorrent and Webshare, with optional TorBox resolution.

The project has its Phase 1 skeleton and provider-independent Phase 2 parsing/matching foundation. The server exposes a valid manifest, health endpoint, and an empty stream response while provider integrations are developed behind tested domain boundaries. The manifest will advertise configuration support only once the configure route exists.

## Requirements

- Node.js 22 or newer
- npm 10 or newer

## Development

```sh
npm install
npm run dev
```

The default server address is `http://127.0.0.1:7000` when accessed locally. It listens on `0.0.0.0` so it also works in a container.

Useful endpoints:

- `GET /health`
- `GET /manifest.json`
- `GET /stream/movie/tt0111161.json`

## Quality gates

```sh
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

See [TECHNICAL_FINDINGS.md](./TECHNICAL_FINDINGS.md) for verified provider/protocol constraints and the remaining Phase 0 validation items.

## Implemented domain pipeline

- Ordered metadata resolver/source contracts with cancellation support
- CZ/SK-aware title normalization and deduplicated movie/episode query generation
- Provider-independent quality, codec, HDR, audio, and language parsing
- Separate scored movie and episode matchers
- Single-episode, multi-episode, and season-pack recognition

Provider playback and TorBox mutations remain intentionally unimplemented until credential-backed behavior is verified.
