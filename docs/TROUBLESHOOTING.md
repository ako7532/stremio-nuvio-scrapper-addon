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
toggles, hard filters, language mode, and playback mode. Webshare also requires a deployment-level exact
`WEBSHARE_PLAYBACK_HOSTS` allowlist; without it, Webshare results are deliberately hidden. One provider
failure should not discard successful results from another provider.

## Rate limits identify the wrong client

Leave `TRUST_PROXY=false` for direct access. Behind a controlled reverse proxy, ensure it overwrites
forwarded-address headers before setting `TRUST_PROXY=true`. Do not enable proxy trust when the backend
port is publicly reachable.

## Container is unhealthy

Check that port 7000 is available, the `/data` volume is writable by the container's Node user, and
`GET /health` succeeds inside the container. Keep application logs sanitized when collecting diagnostics.
