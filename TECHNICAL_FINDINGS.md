# Technical findings

Verified on 2026-09-06. This document records the Phase 0 spike and separates facts from assumptions that still need device or credential-backed tests.

## Decisions that are safe to implement

### One Stremio protocol implementation

The addon will expose the standard HTTP addon routes, starting with:

- `GET /manifest.json`
- `GET /stream/:type/:id.json`

The protocol requires CORS on every route. A stream response can use an HTTP(S) `url`, or a torrent `infoHash` with an optional `fileIdx`. Remote addon installations require HTTPS; loopback development is the exception.

Nuvio documents that it consumes the same manifest and resource routes. We therefore will not build a separate Nuvio backend. Nuvio's own plugin format is unrelated to this project.

Sources:

- [Stremio addon protocol](https://stremio.github.io/stremio-addon-sdk/protocol.html)
- [Stremio stream object](https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/api/responses/stream.md)
- [Nuvio addon integration](https://github.com/haaihond/Nuvio-Wiki/blob/main/docs/integrations/addons.md)

### Playback resolver shape

Search results that require a side effect will use an addon-owned HTTPS `url` containing a short-lived opaque signed token. The actual `GET` to that URL is the earliest reliable point at which a play was requested. The resolver should return an HTTP redirect to the temporary provider media URL, so credentials never enter the Stremio response.

The resolver must implement `HEAD` without mutations and make play/precache idempotency independent of Range requests. Redirect compatibility remains a device-test item below; protocol documentation establishes HTTP URLs as valid streams but does not promise identical redirect behavior in every client.

Do not use `externalUrl` for playback. It represents an external page/action rather than an internal-player media stream, and an open Nuvio issue reports incompatible handling of that property.

Sources:

- [Stremio stream object](https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/api/responses/stream.md)
- [Nuvio `externalUrl` compatibility issue](https://github.com/NuvioMedia/NuvioMobile/issues/1466)

### Webshare.cz supports the required API flow

Webshare has an official form-encoded, XML-response API:

1. `POST /api/search/` searches public files and returns identifier, name, type, size, queue status, votes, and password status.
2. `POST /api/file_info/` enriches a result with availability and removal/copyright state.
3. Authentication is `salt` followed by `login`; login returns a Webshare session token.
4. `POST /api/file_link/` supports `download_type=video_stream` and returns a direct link.

The direct link will only be requested by the playback resolver. All XML responses must be schema-validated because API failures are generally represented in response XML rather than by a useful non-2xx status.

Source: [official Webshare.cz API reference](https://webshare.cz/apidoc/)

### TorBox supports batched cache checks and late link resolution

The current official SDK documentation exposes:

- `GET /v1/api/torrents/checkcached`, accepting multiple hashes with an approximate maximum of 100 per request and optional cached file lists.
- `POST /v1/api/torrents/createtorrent`, accepting a magnet or torrent file.
- `GET /v1/api/torrents/mylist`, needed to find account torrent/file identifiers and avoid duplicate additions.
- `GET /v1/api/torrents/requestdl`, returning a temporary download link or redirecting to it.

All authenticated TorBox calls use a server-held API key. Although TorBox documents a token-bearing permalink, this addon must not expose it because the project security model forbids credentials in playback URLs. The addon resolver will call `requestdl` server-side and redirect to the returned CDN URL.

`checkcached` is suitable for one batched enrichment stage after deduplication. A failed or ambiguous lookup maps to `unknown`, never `uncached`.

Sources:

- [official TorBox Python SDK service documentation](https://github.com/TorBox-App/torbox-sdk-py/blob/main/documentation/services/TorrentsService.md)
- [TorBox API rate limits](https://support.torbox.app/en/articles/13726368-api-rate-limits)

### SKTorrent listing and detail flow

Live anonymous requests confirmed:

- Search uses `GET /torrent/torrents_v2.php` with `search`, `category`, `active`, ordering, language, and page parameters.
- Listing cards expose category, a language flag, title/release text, size, added date, seeders/leechers, detail URL, and a 40-hex `id`.
- Detail pages expose title, category/language flag, size, file list, peer counts, description-level language/subtitle fields, MediaInfo, and a torrent download URL.
- Torrent download returned an authorization error for an anonymous session even though search and detail were accessible.

The 40-hex `id` is highly likely to be the BitTorrent v1 info hash, but that is still an inference. It must be proven against an authenticated `.torrent` fixture before the provider emits it as an `infoHash`. Search and detail parsers must be independent from HTTP and covered by sanitized fixtures.

No stable public API was found. Treat the HTML as an unstable provider contract, use conservative concurrency/timeouts, and fail the provider explicitly when structural invariants disappear.

## Open validation items

These items prevent Phase 0 from being called fully complete:

1. **SKTorrent hash and authentication:** download one legally shareable torrent using a test account, calculate its v1 info hash, compare it with the detail `id`, and determine whether login cookies or constructed magnets are the supported retrieval route.
2. **TorBox response fixtures:** with a test API key, capture sanitized responses for user validation, cached/uncached checks, create-torrent, account list, and request-download-link. Confirm current 429 and `Retry-After` behavior.
3. **Webshare response fixtures:** with a test account, validate the current token transport and whether `video_stream` links support HEAD, Range, and redirect-based playback.
4. **Client matrix:** deploy the resolver over HTTPS and exercise 302/307 redirects, HEAD, and repeated Range requests on Stremio Desktop, Android, Web, and Nuvio. This is a manual/device test and cannot be established from protocol docs alone.
5. **Series identifiers:** confirm all incoming Stremio/Nuvio series ID shapes to parse season/episode without accepting false positives.

## Implementation consequences

- Phase 1 can proceed now: strict project skeleton, protocol routes, domain contracts, and tests do not depend on the open items.
- Phase 2 can proceed with pure metadata/query/parser/matcher code.
- SKTorrent playback, Webshare playback, and TorBox mutation work must wait for sanitized credential-backed fixtures.
- Search handlers must remain side-effect free. TorBox create and precache operations belong only in the playback resolver.
