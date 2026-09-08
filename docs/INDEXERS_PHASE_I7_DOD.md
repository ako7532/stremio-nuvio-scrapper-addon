# Public Indexers Phase I7 audit and Definition of Done evidence

Audit baseline: branch `feature/multi-indexer`, commit `12b3399`, followed by the approved post-I7
server-managed configuration correction. This matrix records repository evidence, not claims about
unavailable live services or devices.

| Definition of Done area                              | Status                                 | Evidence                                                                                                                                                                                                           |
| ---------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Legacy behavior and server-managed default OFF       | Verified by automated tests            | Legacy per-user Indexers fields are stripped; original-provider regression suites remain covered.                                                                                                                  |
| Prowlarr and Jackett normalized contracts            | Verified with mocks/fixtures           | Backend discovery, capabilities, query, parsing, acquisition, error, and partial-failure tests. Live servers remain unverified.                                                                                    |
| Automatic or explicit public torrent selection       | Verified by automated tests            | Empty server selection uses at most 20 eligible public torrent indexers; explicit IDs restrict it. Private, unknown, disabled, non-searchable, and Usenet entries are rejected.                                    |
| Bounded capability-aware movie/series fallback       | Verified by automated tests            | Query planner and provider tests cover IMDb/title and episode/season modes and continue past irrelevant raw results.                                                                                               |
| Identity, deduplication, matching, filters, ranking  | Verified by automated tests            | v1 hash parsing/metainfo verification, shared matcher, source-aware deduplication, hard filters, and deterministic ranking tests.                                                                                  |
| TorBox-only Indexers playback boundary               | Verified by automated tests            | Search and HEAD mutation counters remain zero; selected GET acquisition/playback and precache boundaries are covered.                                                                                              |
| Credential and reference redaction                   | Verified by automated tests and review | Backend credentials exist only in server environment. Public DTO, UI, route logs, errors, and observations exclude endpoints, hashes, magnets, and acquisition references.                                         |
| SSRF and redirect hardening                          | Verified by automated tests            | Exact-origin policy, forbidden IP ranges, private-network policy, DNS rebinding rejection, IP-pinned connection handoff, Prowlarr redirect denial, and Jackett magnet-only redirect acceptance.                    |
| Limits, cancellation, and cache scope                | Verified by automated tests and review | Internal discovery inherits search cancellation, caps capability concurrency at three, and owns discovery/capability/provider-search state inside the per-config runtime.                                          |
| Runtime invalidation                                 | Verified by automated tests            | Configuration update/revoke removes runtime state, torrent files, and old playback references.                                                                                                                     |
| Deployment, configuration, security, troubleshooting | Verified by review                     | README and docs cover server-managed Prowlarr/Jackett, private networking, derived allowlist policy, public-only/TorBox-only behavior, and Save then Install.                                                      |
| Full local quality gate                              | Verified                               | Format check, lint, typecheck, 55 test files with 278 passing tests, build, and `git diff --check` passed after the server-managed configuration correction, live-compatibility fixes, and stream-display refresh. |
| Live Prowlarr, Jackett, and tracker smoke            | Unverified                             | Requires an approved controlled backend and credentials. No live call was made.                                                                                                                                    |
| Live TorBox create/download                          | Unverified                             | Requires explicit user authorization. No live mutation was made.                                                                                                                                                   |
| Browser and Stremio/Nuvio device matrix              | Unverified                             | Requires real browser/device walkthroughs. Fixture and HTTP contract tests do not replace it.                                                                                                                      |

## Runtime and observability audit

- Production runtime keys are configuration ID plus `updatedAt`, bounded to 200 entries with a 30-minute
  sliding TTL. Each runtime owns its providers, discovery/capability caches, and provider-search cache.
- Discovery/capabilities use a five-minute bounded cache; provider search uses the shared two-minute
  bounded cache. Acquired metainfo is stored only in the same configuration namespace. Temporary
  playable links are not stored in these caches.
- Update and revoke call the common invalidation boundary, deleting the runtime, torrent namespace, and
  playback references. No cross-user Indexers cache is present.
- Safe observations contain backend/provider categories and counts only. They do not contain endpoint
  URLs, API keys, info hashes, magnet URIs, torrent bytes, configuration IDs, or acquisition references.
- The deployment remains single-process. Multi-instance deployment needs shared rate-limit and bounded
  cache/reference state before it can preserve the same guarantees.

## Intentionally deferred evidence

No live Prowlarr, Jackett, tracker, TorBox create/download, browser, Stremio, or Nuvio test is claimed.
Those checks require user-controlled services, credentials, or devices and must be recorded separately
with the tested versions and topology. Use the sanitized, mutation-aware procedure in
[`INDEXERS_LIVE_SMOKE_TEST.md`](./INDEXERS_LIVE_SMOKE_TEST.md) when an approved backend is available.
