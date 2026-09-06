# Stremio / Nuvio CZ-SK scraper addon

An early-stage, self-hosted Stremio protocol addon designed to aggregate normalized stream results from SKTorrent and Webshare, with optional TorBox resolution.

The project has its Phase 1 skeleton, provider-independent Phase 2 parsing/matching foundation, and
fixture-backed Phase 3 SKTorrent provider. The server exposes a valid manifest, health endpoint, and an
empty stream response until provider aggregation is connected in Phase 5. The manifest will advertise
configuration support only once the configure route exists.

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
- HTTP-independent SKTorrent listing/detail parsers backed by sanitized HTML fixtures
- Bounded read-only SKTorrent HTML transport and allowlisted listing/detail URL construction
- Authenticated SKTorrent torrent retrieval with mandatory info-hash verification
- Normalized SKTorrent provider results with bounded detail concurrency

Provider playback and TorBox mutations remain intentionally unimplemented until credential-backed behavior is verified.
An authenticated, sanitized fixture proves that the observed 40-character SKTorrent detail identifier
matches the BitTorrent v1 info hash. Torrent metadata parsing still verifies that equality before it may
emit an `infoHash` or magnet URI; page identifiers are never trusted without the downloaded metainfo.
