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

Providers will be isolated with timeouts and settled independently. One failed provider must not discard successful results from another.

## Playback safety

Search is read-only. Results needing Webshare or TorBox resolution point to a short-lived addon-owned play URL. Only a validated GET to that resolver may create/resolve a selected torrent and schedule precache. HEAD is read-only, and idempotency prevents repeated Range requests from scheduling the same work again.

Provider credentials stay in encrypted server-side configuration storage and never appear in manifest, stream, play URLs, frontend state, or logs.
