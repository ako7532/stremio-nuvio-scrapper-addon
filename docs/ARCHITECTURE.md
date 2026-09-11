# Architecture

The addon uses one Stremio HTTP protocol implementation for both Stremio and Nuvio.

## Boundaries

- `http`: transport validation and Stremio response formatting.
- `application`: orchestration use cases; added as each vertical slice needs them.
- `domain`: provider-independent media, release, ranking, and configuration types.
- `metadata`: resolver contracts, title normalization, and search query generation.
- `release`: centralized provider-independent release-name parsing.
- `matching`: separate scored movie and episode matching rules.
- `providers`: capability contracts and provider-specific adapters.
- `infrastructure`: environment, HTTP, persistence, caching, logging, and secrets.

Dependencies point inward. Domain code does not import HTTP, storage, HTML parsers, or provider clients. Provider adapters return normalized domain results before matching, filters, cache enrichment, or ranking run.

## Search pipeline

The required order is:

```text
provider results -> normalize -> parse -> match -> deduplicate -> hard filters
                 -> cache enrichment -> rank -> per-resolution limits
                 -> total limit -> Stremio formatting
```

The `SearchStreams` use case runs enabled providers in parallel and processes each provider's query
variants sequentially. Every query and provider settles independently, so one failure does not discard
successful results. Cancellation is the exception and propagates to the caller. Matching happens before
provider-specific deduplication; hard filters run before an optional cache enricher; production stream
search performs batched read-only TorBox enrichment before ranking; ranking is a
lexicographic comparison of the configured factors with explicit identity tie-breakers. Per-resolution
limits are applied before the total limit.
The total limit also has a server-side cap of 100 results.

The HTTP stream route parses standard IMDb movie IDs and `id:season:episode` series IDs, then delegates
to a bounded production runtime keyed by configuration ID and `updatedAt`. The runtime owns the user's
TMDB resolver, enabled provider adapters, caches, budgets, and playback URL factories. Updates and
revocation discard the searchable runtime while playback still reloads current credentials server-side.

Stream formatting is the last pipeline stage. Direct SKTorrent mode emits a verified `infoHash`;
TorBox-only results require an addon-owned play-URL factory. Production search performs a read-only
cache lookup, labels cached results, and hides uncached results unless the user allows them. Adding a
torrent and resolving its download link happen only after playback GET.
Multi-file series torrents are accepted only through TorBox, where playback selects the requested
episode from the provider-confirmed file list. Webshare results enter ranking and limits only when an addon-owned play-URL
factory is available. Formatting accepts only an HTTPS URL from that factory and never asks Webshare
for a temporary media link during search.

## Playback safety

Search is read-only. Results needing Webshare or TorBox resolution point to a short-lived addon-owned
play URL. Only a validated GET to that resolver may create or resolve the selected torrent. Precache
also runs only from this lifecycle, after the selected provider URL has been resolved. HEAD is
read-only, and idempotency prevents repeated Range requests from repeating playback mutations.

Play tokens use authenticated encryption and contain only bounded provider-specific claims that identify an
expiring server-side playback reference. The reference owns the verified magnet URI and media target;
the token and reference must agree on configuration, provider result, info hash, and episode coordinates.
The TorBox resolver checks the server-side credential reference, reuses a matching torrent already in the
user's account, selects an allowlisted video file, requests the temporary link with a Bearer credential,
and redirects only to an allowlisted TorBox HTTPS host. In-flight and short-lived successful resolutions
are shared by token, making repeated Range requests idempotent. Failed resolution is retryable and first
checks the account again, preventing another torrent creation after an earlier partial success.

The playback reference retains a bounded snapshot of the user's precache policy. After successful
series playback, background discovery searches the configured number of following episodes in the same
season and selects at most one suitable torrent per episode, preferring single episodes over multi-part
releases and season packs. The scheduler excludes unknown, selected, duplicate, low-score,
disallowed-quality, unsafe-size, low-seeder, non-preferred-language, and already-accounted torrents.
Per-user serialization, an hourly create budget, idempotent reference and hash tracking, and provider
`Retry-After` backoff prevent mutation bursts. Precache failures are contained and never delay or fail
the selected redirect.

Webshare uses a separate expiring server-side file reference under the same provider-discriminated token
service. HEAD validates only the reference and current configuration. GET alone authenticates, requests
`file_link`, and accepts only a credential-free HTTPS redirect target. Successful resolutions are shared
briefly for idempotency.

Provider credentials stay in encrypted server-side configuration storage and never appear in manifest, stream, play URLs, frontend state, or logs.

The public HTTP boundary uses bounded fixed-window limiters for configuration mutations, provider
connection tests, searches, and playback resolution. Configured searches are keyed by opaque
configuration ID; unconfigured searches and other potentially expensive operations are keyed by the
direct client address. These in-memory limits fit the documented single-instance self-hosted
deployment and must move to shared state before a multi-instance deployment.

Request logging deliberately disables Fastify's raw URL logging. Completion events contain only the
request ID, method, route template, status, and duration, so dynamic configuration IDs and signed play
tokens do not enter logs. The configure page receives a per-response CSP nonce and configuration API
responses are marked `no-store`. Cross-origin access is enabled only for the Stremio protocol and
playback routes, not for the configuration UI or its API.

Provider transports and parsers are mapped to a provider-independent application error taxonomy before
they cross the HTTP boundary. The public handler returns stable status codes and generic messages for
timeouts, authentication failures, rate limits, unavailable providers, missing media, and playback
failures. Provider `Retry-After` survives the mapping, but provider messages and nested causes do not.
Unexpected exceptions receive a generic 500 response and only a safe category is logged.

Metadata uses a bounded long-TTL cache, provider search uses a bounded short-TTL cache whose key covers
the complete normalized query, and SKTorrent detail pages use a bounded medium-TTL cache keyed by
provider identity and URL. Only successful values are retained and callers receive clones. TorBox cache
status has its own short TTL and bounded entry count; temporary playback links are never placed in these
caches. The default `SearchStreams` assembly enables metadata and provider-result caching.

Each stream provider is wrapped once per `SearchStreams` instance with bounded concurrency and queueing,
a fixed-window operation budget, cancellation-aware waits, and at most one retry. Only transport timeout
and unavailable failures are retryable; authentication, rate limiting, invalid requests, parser failures,
and malformed responses are not. Provider and search observations contain only correlation ID, provider,
duration, counts, cache hits/misses, and application error category. Observers are failure-isolated.

Production startup keeps reverse-proxy trust disabled unless explicitly configured, closes Fastify and
SQLite once on SIGINT or SIGTERM, and enforces a shutdown deadline. The container runs unprivileged with
a read-only root filesystem under Compose, persistent SQLite storage, dropped capabilities, and a health
check. CI repeats formatting, lint, typecheck, tests, build, and production dependency audit.

## Configuration and persistence

The configure page talks to a narrow application service rather than SQLite directly. Its repository
contract stores the public `UserConfiguration` separately from an encrypted credential envelope, so a
later PostgreSQL adapter can replace SQLite without changing the domain or HTTP contract. SQLite uses a
strict table and AES-256-GCM protects credentials with a master key supplied only through
`CONFIG_ENCRYPTION_KEY`.

New configurations receive a random 192-bit URL-safe identifier. API responses return settings and a
masked credential status only; saved passwords and API keys are never returned to the browser.
Credentials can be replaced, explicitly removed, tested server-side, or destroyed by revoking the
whole configuration. Configured manifest and stream paths contain only the opaque identifier.

## SKTorrent parser boundary

The SKTorrent listing and detail parsers consume HTML strings and perform no network requests. They
extract only fields represented in sanitized fixtures and throw `SktorrentParserError` when required
structural invariants disappear. Valid pages with the observed no-results marker return an empty list.

The site's 40-character detail identifier remains an opaque provider ID until authenticated torrent
metadata is downloaded. The torrent parser hashes the exact raw bencoded `info` dictionary and emits an
`infoHash` and magnet URI only when that hash equals the provider ID. The HTML parser itself never makes
that assertion or fetches the parsed download path.

The separate SKTorrent HTTP client performs anonymous read-only GET requests with a bounded timeout and
response size. Listing URL construction uses explicit search parameters, detail URLs are restricted to
the observed SKTorrent origin and path, redirects are rejected, and responses are parsed only after the
transport succeeds. It does not send credentials, retry requests, or fetch torrent download paths.

The authenticated SKTorrent source owns its short-lived login-cookie session and never exposes it to
parsers or normalized results. The provider caps listing candidates before resolving details, processes
details with bounded concurrency, downloads torrent metadata through an ID-checked provider URL, and
normalizes a result only after the torrent parser verifies its info hash.

## Webshare API boundary

The Webshare adapter uses only the official form-encoded XML API. A bounded transport owns endpoint
selection, timeouts, cancellation, redirect rejection, response limits, and XML content checks. Strict
parsers validate success/error envelopes and required search, file-info, and availability fields before
provider normalization.

Public search never authenticates and never creates playback links. A dedicated credential service owns
the username, password, MD5-crypt/SHA-1 login derivation, and lazy session token. The source supplies the
token only in the `wst` POST field when a selected file is resolved through `file_link`; credentials and
temporary links never enter normalized search results. The source caps candidates and bounds concurrent
metadata work. The production runtime connects eligible results to the addon-owned play route.

Credential-backed validation confirms that resolved Webshare HTTPS links support HEAD and byte-range
GET requests. The provider returned the media response directly during the probe; the addon-owned
resolver accepts only a credential-free HTTPS URL and redirects so the temporary provider URL remains
outside Stremio search responses.

## TMDB metadata boundary

TMDB requests use each user's encrypted API Read Access Token as a Bearer header. The client permits
only the official HTTPS origin and explicit authentication, external-ID lookup, detail, and alternative
title paths; redirects are rejected and time, response size, JSON shape, and `Retry-After` are bounded.
IMDb IDs resolve to original/English, Slovak, Czech, and selected alternative titles. Missing or invalid
TMDB credentials fail safely without a shared fallback.
