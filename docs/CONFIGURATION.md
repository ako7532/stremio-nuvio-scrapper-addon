# Configuration reference

Each installation URL contains only a random configuration identifier. Provider credentials are
encrypted in server-side SQLite storage and the browser receives only configured/masked status.

## Providers

- **TMDB** is required for configured searches. Every user supplies their own API Read Access Token;
  there is no shared credential or public metadata fallback.
- **SKTorrent** requires the individual user's username and password. Direct-torrent mode returns only
  a metainfo-verified hash. TorBox-only mode requires that user's TorBox key and never exposes the key,
  magnet URI, or raw hash in an HTTP stream URL.
- **Webshare** requires the individual user's username and password. Search is read-only; authentication
  and temporary link generation happen only on playback GET through server-held provider services.
  The temporary HTTPS media URL is resolved only after an explicit playback GET.
- **TorBox** is optional and uses the individual user's API key only after a playback click: to reuse or
  check the selected torrent, resolve playback, and run explicitly configured alternative precache.

Provider connection tests execute server-side and return sanitized status only. Removing a credential
does not disable its provider toggle automatically; keep enabled providers and available credentials in
sync.

## Matching and display

Resolution, source, video codec, dynamic range, size, seeders, include terms, and exclude terms are hard
filters. Audio and subtitle preferences are independent. Strict language mode excludes releases outside
the configured language rules; fallback mode retains suitable foreign releases when preferred releases
are unavailable.

Ranking is deterministic and follows the displayed factor order. Per-resolution limits apply before the
overall result limit. Compact mode shortens labels; detailed mode includes the normalized release facts.

## TorBox and precache

The source-list request does not contact TorBox, so SKTorrent results are shown without a live cache
label. After a real playback GET, an existing account torrent is reused. If adding uncached torrents is
disabled, the selected hash is checked and a non-cached torrent is rejected without adding it. If it is
enabled, the selected torrent may be added after the click.
Precache count defaults to zero and is capped at ten. For series it searches the following episodes in
the same season and selects at most one suitable torrent for each episode. Precache starts only after a
real GET successfully resolves the selected playback; search and HEAD remain mutation-free. Score,
seeders, size, total size, resolution, and preferred-language limits can narrow eligible episodes.

## Advanced settings

Provider timeout defaults to 8000 ms and is bounded from 1000 to 60000 ms. Safe debug is opt-in, but it
does not permit credentials, authorization headers, configuration IDs, signed tokens, raw URLs, or
provider response bodies to enter logs.

Revoking a configuration deletes its settings and encrypted credentials. Existing installation and play
URLs for that configuration then stop resolving.
