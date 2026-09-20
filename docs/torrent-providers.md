# Torrent search providers

Providers are server-only plain objects: `{ id, name, search(context, { signal }) }`.
The contract and result normalizer are documented with JSDoc in
`lib/search/contract.js`. Register an adapter in the configured array in
`lib/search/provider.js`; search routes and playback consumers require no changes.

Search context includes title, generic/movie/show type, optional TMDB/IMDb IDs,
year, season, and episode. Return an array of candidates. Empty arrays are successful
searches. Pass the supplied abort signal to network requests and release resources
when cancelled. Each provider has an independent 120-second deadline.

Candidates contain title, indexer label, size, seeders, optional leechers, infoHash,
quality, resolution, codec, and optional provider-reported media metadata
(type, tmdbId, imdbId, year, season, episode). Put magnet and HTTP(S) torrent URLs
inside `source`. Do not return raw provider responses. The boundary assigns
providerId/providerName, strips unknown fields, normalizes numeric values, and drops
unusable candidates. Optional unknown fields become null; unknown size/seeders
retain the existing zero defaults. Supported v1 hash-only results receive a
server-side magnet URI; v2-only hashes do not imply playback support.

Providers execute concurrently. Successful results are combined in registration
order before the existing filtering, deduplication, ranking, and streamability
checks. Failures produce only provider IDs and safe categories in server diagnostics.
One successful response, even empty, prevents an aggregate failure. All timeouts
produce HTTP 504; other complete failures produce 502. No configured providers
produces a configuration error (503).

The public search response remains `{ results }`. It adds provider identity,
leechers, quality/resolution/codec, and optional release media metadata. Magnets,
download URLs, and credentials remain private; the client receives an opaque ID
and hasMagnet. Requested playback context is stored separately from release metadata.

## Native providers

Knaben, YTS, and EZTV are enabled by default and can be enabled or disabled from
**Settings → Torrent Sources**. Their selection is stored as the comma-separated
`TORPLAY_NATIVE_PROVIDERS` value. At least one native provider must remain enabled
unless Jackett is configured. Jackett is included separately when its URL and
non-placeholder API key are configured.

`TORPLAY_SEARCH_PROVIDERS` remains an advanced full-provider override. Set it to
a comma-separated allowlist of `knaben,yts,eztv,jackett`; while present, the
Settings controls are read-only. Unknown IDs are rejected. An empty list produces
a configuration error.

Run `npm run dev:native` to start Next.js with only `knaben,yts,eztv`, even if
Jackett credentials exist. This command does not start, stop, or configure Docker,
Jackett, or FlareSolverr. The existing development and Windows launchers are unchanged.

Native adapters use JSON APIs, with no scraping or anti-bot dependency:

- Knaben: general/movie title searches and episode plus season-pack searches;
  at most 150 results per request.
- YTS: movie IMDb-ID lookup, or title search when no IMDb ID exists; at most
  50 movies with one candidate per torrent variant.
- EZTV: show IMDb-ID lookup, filtering episodes and season packs; sequential
  pages of 100, capped at ten pages. Older releases beyond that cap may be omitted.
  Shows without an IMDb ID still search Knaben.

Server-side HTTP(S) endpoint overrides:

| Setting | Default |
| --- | --- |
| `KNABEN_API_URL` | `https://api.knaben.org/v1` |
| `YTS_API_URL` | `https://movies-api.accel.li/api/v2/` |
| `EZTV_API_URL` | `https://eztvx.to/api/` |

YTS and EZTV settings are API base URLs; Knaben is the search endpoint.
The Settings page performs lightweight JSON availability checks for enabled native
providers on load and on request. Results are cached briefly, contain no torrent
results, and never expose provider URLs or credentials. Provider outages or invalid
JSON remain isolated by the shared provider runner.
No mirror discovery or automatic anti-bot workaround is attempted.
Only search/download content you are authorized to access.

Additional indexers, Prowlarr setup, and ranking improvements remain separate work.
