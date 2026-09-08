# Public Indexers Phase I7 audit and Definition of Done evidence

Audit baseline: branch `feature/multi-indexer`, commit `12b3399`. This matrix records repository evidence,
not claims about unavailable live services or devices.

| Definition of Done area                              | Status                                 | Evidence                                                                                                                                                                                             |
| ---------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Legacy behavior and Indexers default OFF             | Verified by automated tests            | Configuration normalization, legacy SQLite, and original-provider regression suites.                                                                                                                 |
| Prowlarr and Jackett normalized contracts            | Verified with mocks/fixtures           | Backend discovery, capabilities, query, parsing, acquisition, error, and partial-failure tests. Live servers remain unverified.                                                                      |
| Explicit public torrent selection                    | Verified by automated tests            | Server-side eligibility filter rejects private, unknown, disabled, non-searchable, and Usenet entries.                                                                                               |
| Bounded capability-aware movie/series fallback       | Verified by automated tests            | Query planner and provider tests cover IMDb/title and episode/season modes and continue past irrelevant raw results.                                                                                 |
| Identity, deduplication, matching, filters, ranking  | Verified by automated tests            | v1 hash parsing/metainfo verification, shared matcher, source-aware deduplication, hard filters, and deterministic ranking tests.                                                                    |
| TorBox-only Indexers playback boundary               | Verified by automated tests            | Search and HEAD mutation counters remain zero; selected GET acquisition/playback and precache boundaries are covered.                                                                                |
| Credential and reference redaction                   | Verified by automated tests and review | Public DTO, UI serialization, route logs, backend errors, and observations exclude endpoint secrets, hashes, magnets, and acquisition references.                                                    |
| SSRF and redirect hardening                          | Verified by automated tests            | Exact-origin policy, forbidden IP ranges, private-network policy, DNS rebinding rejection, IP-pinned connection handoff, Prowlarr redirect denial, and Jackett magnet-only redirect acceptance.      |
| Limits, cancellation, and cache scope                | Verified by automated tests and review | Discovery reuses provider-test rate limits, passes disconnect cancellation, caps capability concurrency at three, and owns discovery/capability/provider-search state inside the per-config runtime. |
| Runtime invalidation                                 | Verified by automated tests            | Configuration update/revoke removes runtime state, torrent files, and old playback references.                                                                                                       |
| Deployment, configuration, security, troubleshooting | Verified by review                     | README and docs cover Prowlarr/Jackett private networking, allowlist policy, public-only/TorBox-only behavior, and Save configuration then Install in Stremio.                                       |
| Full local quality gate                              | Verified                               | Format check, lint, typecheck, 56 test files with 275 passing tests, build, and diff check pass.                                                                                                     |
| Live Prowlarr, Jackett, and tracker smoke            | Unverified                             | Requires an approved controlled backend and credentials. No live call was made.                                                                                                                      |
| Live TorBox create/download                          | Unverified                             | Requires explicit user authorization. No live mutation was made.                                                                                                                                     |
| Browser and Stremio/Nuvio device matrix              | Unverified                             | Requires real browser/device walkthroughs. Fixture and HTTP contract tests do not replace it.                                                                                                        |

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
with the tested versions and topology.
