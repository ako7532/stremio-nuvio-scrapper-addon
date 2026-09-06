# Stremio / Nuvio CZ-SK scraper addon

An early-stage, self-hosted Stremio protocol addon designed to aggregate normalized stream results from SKTorrent and Webshare, with optional TorBox resolution.

The project has its Phase 1 skeleton, provider-independent Phase 2 parsing/matching foundation,
fixture-backed Phase 3 SKTorrent provider, Phase 4 Webshare provider layer, and Phase 5 aggregation
pipeline. Phase 6 adds an injectable TorBox transport, cache enrichment, and secure playback resolver.
Phase 7 adds bounded, play-triggered TorBox precache orchestration.
Phase 8 adds the responsive configure page, encrypted per-user SQLite configuration storage,
masked credential status, credential replacement/removal, provider connection tests, opaque configured
manifest URLs, and revocation. The server stream route accepts the aggregation use case through
dependency injection; concrete metadata-source and per-user playback wiring remain separate from the
configuration slice.

Phase 9 hardening is implemented. The HTTP boundary applies a nonce-based content security policy to
the configure page, disables caching for configuration responses, adds bounded in-memory request
limits, and emits structured route-template logs without configuration IDs, play tokens, credentials,
headers, or raw URLs. Provider, metadata, and playback failures are classified at the application
boundary and HTTP responses expose only stable, sanitized messages. Bounded caches, provider execution
policies, graceful shutdown, a hardened container, and CI quality gates complete the hardening layer.

## Requirements

- Node.js 22 or newer
- npm 10 or newer

## Development

```sh
npm install
npm run dev
```

Create a `.env` file before startup. `CONFIG_ENCRYPTION_KEY` must be a stable, private,
base64-encoded 32-byte key; changing or losing it makes saved credentials unreadable.

```dotenv
CONFIG_ENCRYPTION_KEY=<base64-encoded 32-byte key>
CONFIG_DATABASE_PATH=addon.sqlite
ADDON_BASE_URL=http://127.0.0.1:7000
```

Use HTTPS for `ADDON_BASE_URL` outside local development. Both `.env` and SQLite database files are
ignored by Git.

The default server address is `http://127.0.0.1:7000` when accessed locally. It listens on `0.0.0.0` so it also works in a container.

Useful endpoints:

- `GET /health`
- `GET /manifest.json`
- `GET /configure`
- `GET /:configurationId/manifest.json`
- `GET /:configurationId/stream/movie/tt0111161.json`
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
Operational references are in [deployment](./docs/DEPLOYMENT.md),
[configuration](./docs/CONFIGURATION.md), [security](./docs/SECURITY.md), and
[troubleshooting](./docs/TROUBLESHOOTING.md).

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
- Ranked alternative precache with cache/account deduplication and configurable safety limits
- Once-only background precache with per-user operation budgets and provider backoff
- Responsive configuration UI with mobile-friendly provider, filter, language, sorting, and display controls
- Opaque 192-bit configuration identifiers and configured manifest/stream routes
- AES-256-GCM encrypted provider credentials in a replaceable SQLite-backed configuration store
- Mask-only credential status, credential replacement/removal, provider tests, and configuration revocation
- Typed application error categories with sanitized HTTP status, message, and provider backoff handling
- Bounded metadata, provider-search, SKTorrent-detail, and TorBox-status caches
- Per-provider concurrency, queue, operation-budget, and transient-retry policy
- Safe provider/search/cache observations without queries, media IDs, URLs, or credentials
- Graceful shutdown, explicit reverse-proxy trust, Docker deployment, and CI quality gates

Production metadata and per-user search/playback dependency wiring remain intentionally unimplemented.
The TorBox resolver is connected to the HTTP layer through injection; a real deployment must provide a
server-held credential store, token secret, client factory, cache enricher, playback URL factory, and
precache scheduler. Search and HEAD remain side-effect free. After a real GET has successfully resolved
the selected stream, the scheduler may add only the configured number of eligible uncached alternatives.
The selected torrent is excluded, and precache never delays or fails its playback redirect.
Webshare's authenticated login/link flow is credential-backed and verified at the provider boundary;
its addon-owned playback route still awaits production configuration wiring.
An authenticated, sanitized fixture proves that the observed 40-character SKTorrent detail identifier
matches the BitTorrent v1 info hash. Torrent metadata parsing still verifies that equality before it may
emit an `infoHash` or magnet URI; page identifiers are never trusted without the downloaded metainfo.
