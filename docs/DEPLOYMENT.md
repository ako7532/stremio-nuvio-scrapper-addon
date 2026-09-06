# Deployment

The addon targets a single-instance, self-hosted deployment. Production startup assembles per-user
metadata, providers, caches, and playback dependencies for configured stream routes.

## Required environment

| Variable                  | Required          | Default                 | Purpose                                                                            |
| ------------------------- | ----------------- | ----------------------- | ---------------------------------------------------------------------------------- |
| `CONFIG_ENCRYPTION_KEY`   | Yes               | none                    | Stable base64-encoded 32-byte key used to encrypt per-user provider credentials.   |
| `ADDON_BASE_URL`          | Production        | `http://127.0.0.1:7000` | Public HTTPS base URL placed in generated manifest links.                          |
| `CONFIG_DATABASE_PATH`    | No                | `addon.sqlite`          | SQLite file; the container defaults to `/data/addon.sqlite`.                       |
| `HOST`                    | No                | `0.0.0.0`               | Listen address.                                                                    |
| `PORT`                    | No                | `7000`                  | Listen port.                                                                       |
| `LOG_LEVEL`               | No                | `info`                  | Pino level from `fatal` through `trace`, or `silent`.                              |
| `TRUST_PROXY`             | No                | `false`                 | Trust forwarded client addresses only behind a controlled reverse proxy.           |
| `SHUTDOWN_TIMEOUT_MS`     | No                | `10000`                 | Forced-shutdown deadline, from 1 to 60 seconds.                                    |
| `WEBSHARE_PLAYBACK_HOSTS` | Webshare playback | empty                   | Comma-separated exact HTTPS media hosts verified with the user's Webshare account. |

Generate the encryption key locally and store it in a secrets manager:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Never rotate this key without re-encrypting or intentionally discarding the existing configuration
database. Do not place it in Git, image layers, addon URLs, or proxy configuration.

## Docker Compose

Export `ADDON_BASE_URL` and `CONFIG_ENCRYPTION_KEY`, then run:

```sh
docker compose up --build -d
docker compose ps
```

The Compose service is read-only apart from the named `/data` volume and a temporary `/tmp` mount. It
runs as the unprivileged Node user, drops Linux capabilities, enables `no-new-privileges`, and exposes a
container health check at `/health`.

Terminate with `docker compose down`. Keep the named volume when configurations must survive upgrades.
Back up the SQLite database and encryption key together; either one without the other is insufficient.

## Reverse proxy

Terminate TLS at a controlled reverse proxy and forward traffic to port 7000. Keep `TRUST_PROXY=false`
when clients connect directly. Set it to `true` only when untrusted clients cannot bypass the proxy and
the proxy overwrites forwarded-address headers. Otherwise clients could choose the address used by
rate limiting.

The proxy should preserve GET, HEAD, 302 responses, Range headers, and `Retry-After`. Use its normal
request-size and connection limits in addition to the addon's application limits.

## Shutdown and health

SIGINT and SIGTERM stop accepting work, close Fastify and SQLite once, and enforce the configured
deadline. Orchestrators should use `/health` for liveness and allow at least the shutdown timeout before
sending SIGKILL.
