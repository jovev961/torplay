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

Jackett remains the only configured production provider. Native integrations,
configuration and health UI, Prowlarr setup, and ranking improvements are separate work.
