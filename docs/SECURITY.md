# Security review

## Protected boundaries

- Per-user provider credentials are encrypted at rest and are absent from manifests, stream/play URLs,
  frontend state, fixtures, logs, and error responses.
- Configuration identifiers and play tokens are high-entropy opaque capabilities. Raw URLs are excluded
  from request logs, and configuration responses are `no-store`.
- SKTorrent outbound URLs are restricted to its HTTPS origin and expected paths. A torrent hash is emitted
  only after hashing the exact raw bencoded `info` dictionary and matching the provider identity.
- Webshare uses fixed official HTTPS API operations. TorBox uses a validated HTTPS API base and redirects
  playback only to configured TorBox host suffixes. Provider redirects are rejected where applicable.
- The configure page uses a fresh CSP nonce, cannot be framed, and does not receive wildcard CORS.
- Request bodies, response bodies, candidate counts, concurrency, queues, cache state, and rate-limit key
  counts are bounded. Provider retries apply only to transient transport failures.
- Search and HEAD are read-only. Selected playback and precache mutations are late, server-side,
  token-bound, per-user limited, and idempotent.

## Deployment assumptions

The in-memory caches, operation budgets, playback references, and rate limiters assume one process. A
multi-instance or broadly public deployment requires shared bounded state such as Redis and a durable
database such as PostgreSQL. Reverse-proxy trust is disabled by default and is safe only when the backend
cannot be reached around a proxy that overwrites forwarding headers.

The SQLite database and `CONFIG_ENCRYPTION_KEY` must be protected and backed up together. The opaque
configuration URL is a bearer capability and should not be published. Debug logging never relaxes secret
redaction rules.

## Remaining external validation

Credential-backed TorBox response verification, Webshare link lifetime/rate-limit observation, and the
Stremio Desktop/Android/Web plus Nuvio redirect/HEAD/Range matrix require real user credentials or devices.
They are tracked in `TECHNICAL_FINDINGS.md` and are not replaced by fixture tests.
