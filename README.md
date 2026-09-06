# Stremio / Nuvio CZ-SK scraper addon

An early-stage, self-hosted Stremio protocol addon designed to aggregate normalized stream results from SKTorrent and Webshare, with optional TorBox resolution.

The project has its Phase 1 skeleton, provider-independent Phase 2 parsing/matching foundation,
fixture-backed Phase 3 SKTorrent provider, Phase 4 Webshare provider layer, and Phase 5 aggregation
pipeline. Phase 6 adds an injectable TorBox transport, cache enrichment, and secure playback resolver.
The server exposes a valid manifest and health endpoint; its stream route accepts the
aggregation use case through dependency injection while production provider/configuration wiring
remains deferred until secure per-user configuration exists. The manifest will advertise configuration
support only once the configure route exists.

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
- Official-API Webshare search, file metadata, and availability lookups with validated XML fixtures
- Isolated Webshare salt/login credential service and late playback-link resolver
- Normalized Webshare file results with bounded metadata concurrency
- Parallel provider orchestration with isolated provider/query failures
- Provider-specific deduplication followed by hard filters and optional cache enrichment
- Deterministic configurable ranking and post-ranking per-resolution/total limits
- Compact and detailed Stremio formatting for direct torrents and opaque Webshare play URLs
- Strict parsing of standard Stremio movie and series stream identifiers
- Typed, bounded TorBox authentication, batched cache, torrent, and download-link transport
- Short-lived TorBox cache enrichment with explicit cached, uncached, and unknown states
- Authenticated-encrypted opaque play tokens backed by expiring server-side release references
- Read-only HEAD playback validation and idempotent GET redirect resolution
- Episode-aware video-file selection for single files and season packs
- TorBox-only playback that never exposes API keys, magnet links, or raw info hashes to clients

Production dependency wiring and persistent per-user configuration remain intentionally unimplemented.
The TorBox resolver is connected to the HTTP layer through injection; a real deployment must provide a
server-held credential store, token secret, client factory, cache enricher, and playback URL factory.
Search and HEAD remain side-effect free. A real GET may add only the selected torrent when it is absent
from the user's account, while the broader multi-result precache policy remains deferred to Phase 7.
Webshare's authenticated login/link flow is credential-backed and verified at the provider boundary;
its addon-owned playback route still awaits production configuration wiring.
An authenticated, sanitized fixture proves that the observed 40-character SKTorrent detail identifier
matches the BitTorrent v1 info hash. Torrent metadata parsing still verifies that equality before it may
emit an `infoHash` or magnet URI; page identifiers are never trusted without the downloaded metainfo.
