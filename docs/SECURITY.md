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

## Public Indexers outbound policy

Prowlarr and Jackett endpoints are administrator-owned environment settings. They cannot be supplied or
changed through the public configuration API or browser. The addon derives an exact-origin allowlist
from enabled server backends; configured endpoints may contain a path prefix but cannot contain URL
credentials, query data, or fragments.

Before every production Prowlarr or Jackett request the addon resolves the approved hostname, rejects
invalid, unspecified, multicast, and link-local addresses, and pins the HTTP/TLS connection to the
validated IP while retaining the original Host header and TLS server name. A public FQDN cannot resolve
to private or loopback space, including after DNS rebinding. Explicit IP endpoints, `localhost`, and
single-label Docker service names may use private or loopback networks because the administrator named
that destination directly. Cloud-metadata/link-local addresses remain forbidden.

Prowlarr redirects are never followed. Jackett acquisition accepts only a syntactically valid BitTorrent
v1 magnet redirect and verifies an expected identity when one exists; HTTP(S) redirects are not
followed. Authentication is attached only to requests whose origin passed this policy. Torznab links
are reduced to backend-specific opaque acquisition references rather than fetched as arbitrary URLs.

The policy is one-process state and does not replace egress firewalling. Production deployments should
also isolate the addon and indexer backend on a dedicated network and deny access to host-management and
cloud-metadata ranges.

## Deployment assumptions

The in-memory caches, operation budgets, playback references, and rate limiters assume one process. A
multi-instance or broadly public deployment requires shared bounded state such as Redis and a durable
database such as PostgreSQL. Reverse-proxy trust is disabled by default and is safe only when the backend
cannot be reached around a proxy that overwrites forwarding headers.

The SQLite database and `CONFIG_ENCRYPTION_KEY` must be protected and backed up together. The opaque
configuration URL is a bearer capability and should not be published. Debug logging never relaxes secret
redaction rules.

Indexer discovery is internal to server-managed searches; there is no public discovery endpoint.
Discovery and capability work uses bounded concurrency of three, backend timeouts, and request
cancellation when the client disconnects. Discovery/capability caches and the shared bounded
provider-search cache are created inside the per-configuration runtime. Runtime update/revocation
removes those caches, torrent metainfo, and playback references. This scope is not safe for
multi-instance sharing without a common bounded state store.

## Remaining external validation

Credential-backed TorBox response verification, Webshare link lifetime/rate-limit observation, and the
Stremio Desktop/Android/Web plus Nuvio redirect/HEAD/Range matrix require real user credentials or devices.
They are tracked in `TECHNICAL_FINDINGS.md` and are not replaced by fixture tests.
