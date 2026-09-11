# Troubleshooting

## Startup fails

- Confirm Node.js 22 or newer.
- Set `CONFIG_ENCRYPTION_KEY` to the same valid base64-encoded 32-byte value used when the database was
  created.
- Confirm the process can create and lock `CONFIG_DATABASE_PATH`.
- Outside local development, use an HTTPS `ADDON_BASE_URL` without credentials, query, or fragment.

Startup errors are deliberately sanitized. Use deployment configuration and filesystem checks instead
of adding secrets or complete environment dumps to logs.

## Configuration or provider test fails

- Re-enter that user's provider credential; stored secrets are never returned to the UI.
- A 429 includes `Retry-After`; wait rather than repeatedly retrying.
- A 502 authentication response means the provider rejected the credential.
- A 503/504 indicates temporary provider availability or timeout, not necessarily invalid credentials.

## No streams are returned

Confirm the user has a valid TMDB token and credentials for every enabled provider, then check provider
toggles, hard filters, language mode, and playback mode. One provider failure should not discard
successful results from another provider.

For one affected configuration, enable **Advanced -> Enable safe search debug logs**, save it, and
repeat the failing movie or episode request. Events with the same `correlationId` show resolved titles,
the precise/season/broad queries, provider counts and timings, aggregate matcher/filter rejection
reasons, TorBox cache-state counts, playback exclusions, and the final stream count. Disable the option
after diagnosis to reduce log volume. These events never include credentials, configuration IDs,
provider result IDs or hashes, magnet links, or playback URLs.

## An uncached TorBox stream does not start immediately

The source list does not contact TorBox, so cache state is decided only after the playback click. If
adding uncached torrents is disabled, a non-cached selection is rejected without adding it. If enabled,
the first real `GET /play/...` adds the torrent to the user's TorBox account. While TorBox reports that the download is not both finished and present, the
addon redirects to a short local status video instead of waiting indefinitely. Open the same stream
again after TorBox finishes; pending resolutions are deliberately not cached, so every retry checks the
current state. `HEAD` remains read-only and never adds a torrent.

## Rate limits identify the wrong client

Leave `TRUST_PROXY=false` for direct access. Behind a controlled reverse proxy, ensure it overwrites
forwarded-address headers before setting `TRUST_PROXY=true`. Do not enable proxy trust when the backend
port is publicly reachable.

## Container is unhealthy

Check that port 7000 is available, the `/data` volume is writable by the container's Node user, and
`GET /health` succeeds inside the container. Keep application logs sanitized when collecting diagnostics.
