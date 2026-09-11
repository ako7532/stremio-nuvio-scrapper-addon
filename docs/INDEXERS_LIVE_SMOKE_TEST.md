# Public Indexers live smoke-test runbook

This runbook validates administrator-managed Prowlarr or Jackett backends without confusing fixture
evidence with a live result. Do not copy API keys, configuration identifiers, opaque playback
references, magnet links, info hashes, acquisition references, or complete request/playback URLs into
test notes.

## Safety boundary

Internal backend discovery, movie/series search, configure-page review, and `HEAD` against an opaque
addon playback URL are read-only with respect to TorBox. Stop before a selected playback `GET`. A real
`GET /play/...` or `GET /download/...` may acquire metainfo, create or reuse a TorBox torrent, request a
playable link, and start configured following-episode precache. It requires separate explicit
authorization.

## Administrator preconditions

- Enable only an approved backend with `SCRAPE_PROWLARR=true` or `SCRAPE_JACKETT=true`.
- Keep its URL and API key in the server environment. Do not enter or expose them in `/configure`.
- Configure only public torrent indexers in Prowlarr/Jackett. An empty `PROWLARR_INDEXERS` or
  `JACKETT_INDEXERS` JSON array automatically uses up to 20 eligible public indexers; a non-empty array
  restricts the search to explicit IDs.
- Keep the backend authenticated and preferably reachable only through the private Docker or Tailscale
  network described in `DEPLOYMENT.md`.
- Start the addon with its stable encryption key, writable configuration database, and correct addon
  base URL. Do not print an environment dump as evidence.
- Record addon/backend versions and the private-network topology without disclosing sensitive internal
  addresses.

## User configuration preconditions

1. Open `/configure` through an already approved route.
2. Confirm that there is no Public Indexers connection card, endpoint field, API-key field, discovery
   button, or indexer selection.
3. Enter the user's TMDB and TorBox credentials locally and test them. Do not share their values.
4. Set following-episode precache to `0`, enable safe search debug logs, select **Save configuration**,
   and do not install yet.
5. Take a before-test snapshot of TorBox account and queued-download counts without torrent names,
   hashes, or links.

## Prowlarr or Jackett read-only smoke

Run this section once for every enabled server backend:

1. Request one legal movie control and one legal series-episode control through the configured stream
   route. Search internally discovers and validates the configured backend indexers.
2. A successful smoke result has at least one relevant matched Indexers stream. Zero results are useful
   evidence only when the safe summary distinguishes no match from backend failure.
3. Record only the `indexers-provider-summary` fields: selected and eligible counts, query count,
   matched count, acquisition attempt/failure counts, returned count, timing, and sanitized error
   categories. Do not copy queries or raw backend responses.
4. Confirm there are no `torbox-playback-stage` or `torbox-precache-stage` events and no TorBox account or
   queued-download count change after both searches.
5. Keep one addon-owned opaque playback URL only in the local test session. Send `HEAD` to that exact URL
   without following redirects. Expect `204` for a valid reference.
6. Confirm again that no TorBox account/queue count changed and no TorBox playback/precache stage was
   logged. Delete local command history or temporary captures containing the complete URL.

If both Prowlarr and Jackett are enabled, their results may be searched together and are deduplicated by
verified torrent identity. Diagnose each backend separately by temporarily disabling the other in the
server environment and restarting the addon; do not expose an administrative backend switch in the
user configuration page.

## Optional authorized playback test

Perform this section only after explicit authorization for a live TorBox create/download operation.

1. Keep precache at `0` and take a fresh TorBox count snapshot.
2. Select exactly one previously verified Indexers stream and allow one non-following playback `GET`.
3. Record only the ordered safe playback stages and their outcome/category/timing. Do not record the
   opaque URL, redirect target, torrent identity, or provider acquisition reference.
4. Confirm that the selected item was reused or added at most once. Repeated GET/Range requests must not
   create duplicates.
5. Only after this passes, optionally repeat a series test with the intended following-episode precache
   count and account separately for discovered, selected, added, failed, and skipped episodes.

## Evidence record

Use one row per backend and do not mark unavailable work as passed:

| Check                                        | Status                       | Sanitized evidence                                     |
| -------------------------------------------- | ---------------------------- | ------------------------------------------------------ |
| Server configuration and internal discovery  | Pass / Fail / Blocked        | Backend type, versions, eligible count, error category |
| User configure page has no Indexers controls | Pass / Fail / Blocked        | Checklist result only                                  |
| Movie search                                 | Pass / Fail / Blocked        | Selected/eligible/query/matched/returned counts        |
| Series search                                | Pass / Fail / Blocked        | Selected/eligible/query/matched/returned counts        |
| Search caused no TorBox mutation             | Pass / Fail / Blocked        | Before/after account and queue counts only             |
| Playback HEAD caused no TorBox mutation      | Pass / Fail / Blocked        | HTTP status and before/after counts only               |
| Selected playback GET                        | Pass / Fail / Not authorized | Safe stage outcomes only                               |
| Stremio/Nuvio device test                    | Pass / Fail / Not run        | Client/version and behavior category only              |

Fixture tests, successful startup, or an empty TorBox dashboard do not prove live search, playback, or
device compatibility. Preserve raw evidence only in a private local session and share the sanitized
record above.
