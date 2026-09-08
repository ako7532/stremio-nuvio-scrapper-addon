# Indexers technical findings

Date: 2026-09-08  
Phase: I0 technical audit and spike  
Audited commit: `652b29c` (`feature/multi-indexer`, also local `main`)  
Working tree at audit start: user-owned modification in `.gitignore`; no Indexers implementation was present.

## Baseline

The existing addon is the implementation base. This work must extend it rather than duplicate its metadata, matching, aggregation, configuration, or playback layers.

The baseline quality gates all passed before Indexers changes:

- `npm run format:check`: passed.
- `npm run lint`: passed.
- `npm run typecheck`: passed.
- `npm test`: 44 files and 219 tests passed.
- `npm run build`: passed.

No live Prowlarr, Jackett, tracker, TorBox mutation, Stremio, or Nuvio test was run during this spike.

## Existing contracts and coupling

`src/domain/release.ts` currently has two provider names. Its torrent result is discriminated by `provider: 'sktorrent'`, requires a v1 `infoHash`, and carries an optional verified magnet. Webshare remains a separate file-hosting result. `StreamProvider` accepts the existing title-oriented `SearchQuery`; provider capabilities are intentionally small.

The hardcoded SKTorrent torrent branches that must become capability/source based are:

- `src/aggregation/result-deduplicator.ts`: torrent dedup key.
- `src/aggregation/result-ranking.ts`: cache and provider priority.
- `src/aggregation/result-filters.ts`: minimum-seeder filtering.
- `src/http/stream-formatter.ts`: direct-torrent versus TorBox URL, cache label, provider label.
- `src/application/search-streams.ts`: TorBox eligibility, cache availability, cache counts, and following-episode candidates.
- `src/application/torbox-cache-enricher.ts`: hash extraction and enriched result update.
- `src/application/production-integration.ts`: resolver dispatch and precache candidate projection.
- `src/application/torbox-playback.ts`, `src/security/play-token.ts`, and `src/application/playback-reference-store.ts`: token/reference types and selected playback.

These paths already have regression coverage in the aggregation, search, formatter, production integration, cache enrichment, playback, play-token, and precache test suites. The baseline contains 62 SKTorrent references across the relevant application, aggregation, and HTTP tests.

The minimal I1 refactor should introduce torrent type guards and provider playback policy helpers. It should not generalize Webshare or change SKTorrent direct playback. Indexers must be represented as torrent results but always select TorBox playback.

## Search orchestration

The shared orchestration searches providers in parallel and query variants within a stage in parallel. A provider stops before the next stage when any raw result exists. That behavior is covered for the existing title-query pipeline and must remain unchanged for SKTorrent and Webshare in I1.

Indexers needs its own capability-aware bounded planner. Its fallback decision must be based on matched/relevant candidates and remaining budget, not merely raw count. This avoids a cross-provider rewrite of the established query generator.

`MediaRequest.id` already preserves an IMDb series or movie ID when the Stremio request uses one. TMDB resolution currently drops the source external ID. Add an optional, validated `imdbId` to `MediaMetadata` in the Indexers phase so the planner does not parse an arbitrary identifier. For TMDB/TVDB-origin requests, the current TMDB client would need a separately verified external-ID lookup before claiming IMDb support; title fallback remains valid meanwhile.

## Prowlarr contract

Verified against the current upstream `develop` OpenAPI document on 2026-09-08:

- Discovery is `GET /api/v1/indexer` and returns `IndexerResource[]`.
- The resource exposes `id`, `name`, `enable`, `supportsSearch`, `supportsPagination`, `protocol`, `privacy`, `capabilities`, priority, and status fields.
- `protocol` is one of `unknown`, `usenet`, or `torrent`; `privacy` is one of `public`, `semiPrivate`, or `private`.
- The V1 allow rule is exact: `enable === true`, `supportsSearch === true`, `protocol === 'torrent'`, and `privacy === 'public'`. Missing or unknown values are denied.
- Per-indexer Torznab-compatible access is `GET /api/v1/indexer/{id}/newznab`. It includes `t`, `q`, `cat`, `imdbid`, `limit`, `offset`, `season`, `ep`, `year`, and other Newznab parameters.
- Acquisition is a separate `GET /api/v1/indexer/{id}/download` route with a backend-issued `link` or `file` reference. A result GUID must not be synthesized into this route.
- Prowlarr supports `X-Api-Key` header authentication and query authentication. The addon will use only `X-Api-Key`, attach it only to the configured backend origin, and never copy it to a redirect target.

The Prowlarr JSON capabilities can guide discovery, but per-indexer `t=caps` remains the search protocol authority and permits one parser contract to be shared with Jackett.

## Jackett contract

Verified against the current upstream Jackett README, `ResultsController`, and
`DownloadController` source on 2026-09-08:

- Per-indexer requests use `GET /api/v2.0/indexers/{indexerId}/results/torznab/api`.
- `t=caps` reports the actual modes and parameters supported by a specific indexer.
- Discovery is `t=indexers` on the `all` Torznab endpoint and supports `configured=true`.
- Normal search must use explicit per-indexer endpoints, not `all`; Jackett documents loss of per-indexer capability control and slow-indexer isolation on the aggregate route.
- Jackett authenticates these routes with `apikey`. The key is necessarily a query parameter to the configured Jackett origin, must be redacted, and must never be forwarded to a tracker/download redirect.
- The current `t=indexers` response has an `<indexers>` root and one `<indexer id="..." configured="...">` per tracker. Each entry includes `title`, `description`, `link`, `language`, `type`, and an embedded `caps` element.
- Jackett returns its configured tracker type in `type` (`public`, `semi-private`, or `private`). V1 accepts only an explicit `public` value; missing and unknown values are denied.
- Supported movie/TV parameters include `q`, `imdbid`, `year`, `season`, and `ep`, but each indexer can expose only a subset; `t=caps` is authoritative.
- Search results rewrite release links to Jackett's own proxy download route. The current download controller uses `/dl/{indexerId}` with protected `path`, optional `file`, and `jackett_apikey` query parameters. It can return a magnet redirect or normalized `.torrent` bytes.
- The adapter must accept only the configured Jackett origin and matching indexer route, discard any credential-bearing result URL, and retain a backend-local opaque reference. Acquisition must use that validated reference rather than constructing a download from an RSS GUID.

These source-backed contracts are represented by anonymized I4 fixtures. A controlled live Jackett instance is still required to check deployment-specific base paths, proxy host generation, tracker quirks, and actual redirect behavior.

## Torznab result and identity semantics

Torznab is an XML/RSS API. `t=caps` declares search modes, supported parameters, limits, categories, and paging. Search responses can contain ordinary RSS fields plus repeated `torznab:attr` or `newznab:attr` values.

The following values are distinct and must remain distinct in the model:

- RSS `guid`: a release/backend identifier; never a torrent hash by itself.
- `infohash`: a claimed BitTorrent identity that requires strict normalization and conflict checks.
- magnet/enclosure/link: a candidate acquisition location or magnet; not automatically trusted.
- backend download reference: an opaque value usable only with the same configured backend/indexer.
- `.torrent` metainfo: authoritative only after hashing the exact raw bencoded `info` bytes.

I2 should use a bounded XML parser with DTD/entity rejection, response-size and item limits, namespace-insensitive handling of the two accepted attribute namespaces, duplicate-field conflict detection, and schema validation before domain conversion.

## Supported torrent identity

V1 will support only BitTorrent v1 BTIH normalized to 40 lowercase hexadecimal characters. A valid 32-character base32 BTIH may be decoded to those 20 bytes. A magnet is accepted only when an `xt=urn:btih:` value produces the same canonical identity as any declared hash.

BTMH/v2 and hybrid-only identities are not converted, truncated, or presented as v1. This is required by the current local implementation:

- the TorBox client normalizes 40-hex hashes for cache checks;
- `TorrentFileStore` keys only 40-hex infohashes;
- SKTorrent calculates SHA-1 over the exact raw `info` dictionary;
- token/reference matching and account-torrent lookup compare the v1 hash.

The current official TorBox SDK documents generic hash cache checks and magnet/file torrent creation, but does not establish an end-to-end v2 identity contract compatible with this addon. V2 therefore remains explicitly unsupported until a fixture-backed transport change proves it.

## TorBox and side-effect boundary

The current local TorBox transport matches the official SDK endpoints for cache lookup, account torrent listing, torrent creation by magnet or file, and request-download-link. Cache lookup is bounded to 100 hashes locally and upstream documents roughly the same maximum.

The established boundary is retained:

- stream search may parse or safely acquire metadata, and may perform a read-only cache lookup when configured, but must not create a TorBox torrent, start precache, or request a playable link;
- HEAD only validates the opaque playback reference and stored credential presence;
- selected playback GET lists/checks the account/cache as needed, creates only the selected torrent when policy permits, selects the media file, requests the playable link, and only then arms background precache;
- `unknown` cache state remains unknown on missing, malformed, or failed cache evidence.

Critical tests must count all create, create-file, playable-link, and precache calls across search and HEAD, not only assert the returned stream shape.

## Configuration persistence and runtime invalidation

SQLite stores per-user configuration JSON and encrypted user credentials without a schema-version
column. Indexers were initially implemented there in I6, but the approved post-I7 product correction
moved Prowlarr/Jackett ownership to server runtime settings, matching the operator-managed scraper model.
Read-time normalization now strips legacy per-user Indexers settings and credentials without requiring
a database table rewrite. New public configuration payloads and DTOs contain no Indexers fields.

Backend URL, backend type, API key, and optional indexer IDs now come only from administrator-owned
environment settings. Enabled backend origins form the exact outbound allowlist. Public DTOs, manifests,
browser state, logs, and acquisition references must not expose these values.

Production runtimes are cached per configuration ID and `updatedAt` for 30 minutes by default, bounded to 200 entries. Configuration update/revocation already invalidates the runtime and torrent-file namespace. Indexer discovery, capability, search, and acquisition caches must be owned by that runtime so the existing invalidation boundary removes them as well.

## Minimal phased change set

- I1: `domain/release`, torrent guards/policy helpers, dedup/ranking/filter/formatter/cache/playback dispatch, and regression tests. No enabled Indexers provider yet.
- I2: isolated `providers/indexers` Torznab types, safe parser, identity utilities, query planner, fixtures, and unit tests.
- I3: Prowlarr discovery/search/acquisition client with origin-bound header auth, limits, partial failure, and mock integration tests.
- I4: Jackett adapter with query auth redaction and fixture-backed discovery/acquisition behavior.
- I5: production assembly, opaque selected-playback references, TorBox-only eligibility, cross-indexer/source-aware dedup, and critical side-effect tests.
- I6: originally added per-user settings; the approved post-I7 correction replaced them with
  server-managed environment settings and removed the public UI/discovery surface.
- I7: SSRF/redirect hardening, observability, deployment and user documentation, full regression gates, and only the available controlled smoke tests.

## Unverified assumptions and required evidence

- No controlled Prowlarr or Jackett server was available, so current live response quirks, redirects, rate limiting, and tracker failures are unverified.
- Jackett discovery and acquisition behavior is verified only against current upstream source and mock fixtures, not a controlled live server.
- Prowlarr/Jackett may emit tracker-specific duplicate/conflicting Torznab attributes; parser policy will be fixture-tested rather than inferred.
- TorBox v2/hybrid behavior, live cache results, create behavior, and device playback were not tested and are not claimed.
- Stremio/Nuvio device compatibility remains a later explicit smoke test.

## Phase I7 hardening result

Production Prowlarr and Jackett requests now pass through the administrator-owned exact-origin policy
on every outbound operation. The policy resolves the destination, rejects forbidden or unexpected
private address classes, and passes a validated address to a pinned HTTP/TLS connection so a second DNS
lookup cannot change the destination. Explicit IP endpoints, loopback, and single-label Docker service
names preserve intentional private-network deployment; link-local/cloud-metadata destinations remain
forbidden. Prowlarr redirects are rejected, while Jackett accepts only a validated magnet redirect.

Chunked discovery, capability, search, and acquisition bodies are stopped while streaming as soon as
their configured byte limit is crossed. Discovery is now internal to a user-triggered search and
inherits its cancellation and bounded provider execution policy; no public discovery route remains.

The evidence matrix, cache/observability review, deployment guidance, and remaining live/device checks
are maintained in [`INDEXERS_PHASE_I7_DOD.md`](./INDEXERS_PHASE_I7_DOD.md).

## Primary sources

- Prowlarr current OpenAPI: https://raw.githubusercontent.com/Prowlarr/Prowlarr/develop/src/Prowlarr.Api.V1/openapi.json
- Prowlarr repository: https://github.com/Prowlarr/Prowlarr
- Jackett API usage: https://github.com/Jackett/Jackett#api-usage
- Jackett definition format: https://github.com/Jackett/Jackett/wiki/Definition-format
- Jackett ResultsController: https://github.com/Jackett/Jackett/blob/master/src/Jackett.Server/Controllers/ResultsController.cs
- Jackett DownloadController: https://github.com/Jackett/Jackett/blob/master/src/Jackett.Server/Controllers/DownloadController.cs
- Torznab 1.3 specification: https://torznab.github.io/spec-1.3-draft/torznab/Specification-v1.3.html
- TorBox official JavaScript SDK torrent service: https://github.com/TorBox-App/torbox-sdk-js/blob/main/documentation/services/TorrentsService.md
