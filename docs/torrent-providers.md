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

## Source-neutral configuration

Torrent sources are optional; none are added or enabled automatically. Under
**Settings → Torrent Sources → Add source**, users can add a TorPlay Tested Source,
explore community Cardigann v11 definitions, or use **Advanced setup** for a
custom Torznab endpoint or definition URL. An independently operated Prowlarr
instance can be added as a custom Torznab source. Jackett is configured as an
optional external service under **Settings → Services**; after validation, add
its configured indexers individually under **Torrent Sources**. TorPlay never
starts, stops, or configures these external services.

`TORPLAY_SEARCH_PROVIDERS` is an optional advanced full-provider allowlist. It
accepts the stable IDs of added Tested Sources and saved `custom-...`,
`jackett-...`, or `cardigann-...` sources. Unknown IDs are rejected, and an empty list produces a
configuration error. A legacy `jackett` override still selects Jackett sources.
No mirror discovery or mandatory anti-bot service is used.
Only search/download content you are authorized to access.

## TorPlay Tested Sources

These optional native integrations are listed in the Add source dialog. Choose
**Add** for a source you want to use; it can later be disabled, enabled, or
removed under **Torrent Sources**. **Refresh availability** checks its status.
Removing one does not add it again. A configured source reports its own
availability, independently of other sources.

## Custom Torznab providers

Use **Settings → Torrent Sources → Add source → Advanced setup → Add Custom Indexer**. Enter a name, the complete Torznab API endpoint (for example `http://localhost:9696/1/api`), and its API key if required. Do not include query parameters or credentials in the URL. Capabilities determine Movies/TV support, and a minimal search verifies access before connection settings are saved. Empty search results are valid.

Custom providers can be edited, enabled, disabled, or removed. Health is checked on load and refreshed manually. Disabled providers make no requests. Credentials remain server-side; editors on the trusted private network can see the configured endpoint. Redirects are rejected to prevent credential forwarding.

Enabled custom providers join the existing provider runner and share filtering, deduplication, ranking, and failure isolation. A full `TORPLAY_SEARCH_PROVIDERS` override includes a custom provider only when its stable `custom-...` ID is listed. The ID is stored in the private configuration file. Capabilities constrain the search modes and parameters used.

## Jackett sources

Run Jackett independently, save and test its base URL and API key in **Services**,
then use **Torrent Sources → Add source → Jackett** to choose a configured indexer.
Each indexer is a separate source with Movies and/or TV Shows selected according
to its capabilities. Jackett credentials remain in Services; changing them affects
all Jackett sources. No source is added merely by configuring the service. Existing
sources remain saved but report unavailable when Jackett is offline.

## Imported Cardigann definitions

Use **Settings → Torrent Sources → Add source → Advanced setup → Import Indexer Definition** to add a
Cardigann v11 YAML definition from a public HTTPS URL. TorPlay accepts direct YAML
URLs and normal GitHub `blob` pages, which it converts to their raw-file URL. The
complete response is parsed safely, validated against a pinned v11 schema, and
analyzed for required execution features before any provider settings are shown
or saved. The preview is derived from that parsed definition; it does not reduce
or replace the imported YAML. The community browser loads a pinned definition
directory on demand; its entries are not pre-added or enabled sources.

You can select an entry in **Explore Cardigann indexers** without copying a URL.
If you need to import a different definition, browse the community-maintained
[Prowlarr v11 definitions](https://github.com/Prowlarr/Indexers/tree/master/definitions/v11),
open the individual `.yml` file for the indexer, and copy that file page's browser
URL. Do not paste the torrent indexer's own website URL. GitHub's **Raw** button is
not required.

The in-app community browser shows definitions with supported movie or TV categories
that have not already been added, including anime-capable sources. Use its
Movies, TV / Series, and Anime filters alongside the All, Public, Semi-public,
and Private access select; a source supporting multiple categories appears in
each matching filter. Access badges (Public, Semi-public, Private) and the
FlareSolverr marker come from the definition at the pinned community revision.
Semi-public is the UI label for the upstream `semi-private` type; it may require
registration or other access before an indexer can be used.
These labels describe the upstream definition, not a live availability or
compatibility guarantee; selecting a source still runs the normal import checks.

Imported definitions run entirely on the TorPlay server. Secret settings,
cookies, passwords, magnets, torrent files, and download URLs are not exposed to
the browser. Text and password settings are optional in the import form, although
the indexer may need them to connect; select settings without defaults require a
choice. After the user confirms the preview, TorPlay attempts a live
definition-driven search. If compatibility checks pass but connection verification
fails, **Add Anyway** explicitly saves the source as unverified; **Test** can check
it again later. Saved definitions live in the
same private `torrent-providers.json` file as custom Torznab providers. The
original YAML is retained byte-for-byte together with its SHA-256 integrity hash
and is the authoritative definition when reloaded. Older parsed-only records
remain readable and are converted to canonical YAML the next time provider
settings are saved. Secret settings require the indexer's own links to use HTTPS.

The generic engine supports definition-driven GET/POST and raw search inputs,
templates and filters, categories, HTML/JSON/XML parsing, declared response
encodings, public/cookie/form authentication, selector-derived login values,
session cookies, error selectors, and direct or multi-step torrent downloads.
Definitions marked `info_flaresolverr` use an optional external FlareSolverr
service configured under **Settings → Services**. When one of those sources is
searched, compatible HTML GET and form POST requests go through FlareSolverr's
`/v1` API to handle browser challenges; torrent downloads remain direct. Without
a configured service, those marked definitions cannot search successfully. The
service must be on this computer or a private LAN address. TorPlay never manages it.
Other definitions continue to use direct HTTP, and OMDb ratings remain independent.

Definitions that require CAPTCHA, custom
certificate pinning, torrent-link self-testing, an unavailable text encoding, or
another unknown operation are rejected during import. Every compatibility error
names the unsupported feature and its YAML path; sections are never silently
ignored. TorPlay never installs or globally requires an anti-bot service.

Developers can audit a locally supplied Cardigann v11 corpus without downloading
or bundling a catalog:

```sh
npm run audit:cardigann -- /path/to/definitions/v11
```

The audit reports compatible, explicitly unsupported, and schema-invalid files.
Add `--details` to include the per-definition classifications.
