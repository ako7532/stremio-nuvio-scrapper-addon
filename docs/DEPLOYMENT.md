# Deployment

The addon targets a single-instance, self-hosted deployment. Production startup assembles per-user
metadata, providers, caches, and playback dependencies for configured stream routes.

## Required environment

| Variable                | Required   | Default                 | Purpose                                                                          |
| ----------------------- | ---------- | ----------------------- | -------------------------------------------------------------------------------- |
| `CONFIG_ENCRYPTION_KEY` | Yes        | none                    | Stable base64-encoded 32-byte key used to encrypt per-user provider credentials. |
| `ADDON_BASE_URL`        | Production | `http://127.0.0.1:7000` | Public HTTPS base URL placed in generated manifest links.                        |
| `CONFIG_DATABASE_PATH`  | No         | `addon.sqlite`          | SQLite file; the container defaults to `/data/addon.sqlite`.                     |
| `HOST`                  | No         | `0.0.0.0`               | Listen address.                                                                  |
| `PORT`                  | No         | `7000`                  | Listen port.                                                                     |
| `LOG_LEVEL`             | No         | `info`                  | Pino level from `fatal` through `trace`, or `silent`.                            |
| `TRUST_PROXY`           | No         | `false`                 | Trust forwarded client addresses only behind a controlled reverse proxy.         |
| `SHUTDOWN_TIMEOUT_MS`   | No         | `10000`                 | Forced-shutdown deadline, from 1 to 60 seconds.                                  |

Server-managed Public Indexers use these settings:

| Variable            | Default                 | Purpose                                                          |
| ------------------- | ----------------------- | ---------------------------------------------------------------- |
| `SCRAPE_PROWLARR`   | `false`                 | Enable the server's Prowlarr scraper.                            |
| `PROWLARR_URL`      | `http://127.0.0.1:9696` | Administrator-controlled Prowlarr endpoint.                      |
| `PROWLARR_API_KEY`  | none                    | Required when Prowlarr is enabled.                               |
| `PROWLARR_INDEXERS` | `[]`                    | JSON array of IDs; empty uses up to 20 eligible public trackers. |
| `SCRAPE_JACKETT`    | `false`                 | Enable the server's Jackett scraper.                             |
| `JACKETT_URL`       | `http://127.0.0.1:9117` | Administrator-controlled Jackett endpoint.                       |
| `JACKETT_API_KEY`   | none                    | Required when Jackett is enabled.                                |
| `JACKETT_INDEXERS`  | `[]`                    | JSON array of IDs; empty uses up to 20 eligible public trackers. |

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

## Prowlarr or Jackett on a private Docker network

Attach the addon and its server-managed backend to the same Compose network. The backend URL may contain
a path prefix. Keep the API key in the deployment secret environment and never in the addon UI:

```yaml
services:
  addon:
    environment:
      SCRAPE_PROWLARR: 'true'
      PROWLARR_URL: http://prowlarr:9696
      PROWLARR_API_KEY: ${PROWLARR_API_KEY:?Set PROWLARR_API_KEY}
      PROWLARR_INDEXERS: ${PROWLARR_INDEXERS:-[]}
    networks: [indexers]

  prowlarr:
    image: lscr.io/linuxserver/prowlarr:latest
    volumes:
      - prowlarr-config:/config
    networks: [indexers]

networks:
  indexers:
    internal: true

volumes:
  prowlarr-config:
```

For Jackett use `http://jackett:9117`, `lscr.io/linuxserver/jackett:latest`, and a separate `/config`
volume. The backend port does not need to be published to the host for addon access. Temporarily publish
the administration UI only on a trusted interface if needed, configure authentication, add only public
torrent indexers, then remove that mapping. Do not expose Prowlarr or Jackett unauthenticated.
The image names and default ports follow the
[Prowlarr container documentation](https://docs.linuxserver.io/images/docker-prowlarr/) and
[Jackett container documentation](https://github.com/linuxserver/docker-jackett/blob/master/README.md).

For a backend behind a controlled HTTPS reverse proxy, configure its exact administrator-owned URL.
Public FQDNs resolving to private addresses are rejected; use an explicit private IP, `localhost`, or a
single-label Docker service name when private routing is intentional. The addon derives the outbound
origin allowlist from enabled backend URLs and pins each connection to a validated address.

Prowlarr and Jackett may both be enabled. Configure tracker membership in those administrator tools,
not in `/configure`. The normal user only supplies their TorBox credential and follows **Save
configuration**, then **Install in Stremio**. Server-managed Indexers is automatically available to
that user and remains public-only and TorBox-only.

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
