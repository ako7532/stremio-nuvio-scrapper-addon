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
provider-specific deduplication; hard filters run before an optional cache enricher; ranking is a
lexicographic comparison of the configured factors with explicit identity tie-breakers. Per-resolution
limits are applied before the total limit.
The total limit also has a server-side cap of 100 results.

The HTTP stream route parses standard IMDb movie IDs and `id:season:episode` series IDs, then delegates
to an injected `SearchStreams` implementation. This keeps provider credentials and future per-user
configuration outside the transport layer. Without that production wiring, the route preserves the
valid empty stream response used by the skeleton.

Stream formatting is the last pipeline stage. Direct SKTorrent mode emits a verified `infoHash`;
TorBox-only results and multi-file series results without a selected filename stay hidden until Phase 6
supplies its resolver. Webshare results enter ranking and limits only when an addon-owned play-URL
factory is available. Formatting accepts only an HTTPS URL from that factory and never asks Webshare
for a temporary media link during search.

## Playback safety

Search is read-only. Results needing Webshare or TorBox resolution point to a short-lived addon-owned play URL. Only a validated GET to that resolver may create/resolve a selected torrent and schedule precache. HEAD is read-only, and idempotency prevents repeated Range requests from scheduling the same work again.

Provider credentials stay in encrypted server-side configuration storage and never appear in manifest, stream, play URLs, frontend state, or logs.

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
metadata work. Phase 5 will connect those results and an addon-owned play route to the HTTP layer.

Credential-backed validation confirms that resolved Webshare HTTPS links support HEAD and byte-range
GET requests. The provider returned the media response directly during the probe; the addon-owned
resolver may still use a redirect so the temporary provider URL remains outside Stremio responses.
