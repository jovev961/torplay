# Sources and search

Sources are optional and user-controlled. Fresh installations configure zero
sources. Add and enable sources in **Settings → Video sources**; browsing a
community directory or importing a definition does not enable it. The optional
`TORPLAY_SEARCH_PROVIDERS` allowlist limits already configured sources; it never
creates a source. An empty allowlist excludes every source.

TorPlay Tested Sources are native integrations tested for technical compatibility.
The label does not endorse, verify, guarantee, or make claims about their content.
Their individual names appear in the application, rather than general documentation.
Choose **Add and enable** to use one, or disable/remove it later.

## Custom indexers and community definitions

**Custom Indexer** accepts a Torznab API endpoint such as your own independently
operated Prowlarr or Jackett endpoint. Supply the full HTTP(S) endpoint without URL
credentials, query parameters, or fragments. API keys remain server-side. Explicit
local/LAN service endpoints are supported; link-local and other reserved destinations
are blocked. Redirects must remain within the configured origin.

An optional external Jackett service can also be configured under **Services**.
Choose its individual configured indexers in the source dialog. Their settings
remain linked to that service. Configuring a service alone does not add sources.
TorPlay does not start, stop, bundle, or manage these external services.

Cardigann v11 definitions can be selected through the community browser or imported
from a public HTTPS YAML URL. Individual GitHub file-page URLs are accepted.
Definitions remain definition-driven and are checked against the pinned v11 schema
and supported operations. Unsupported required features receive explicit diagnostics.
The community list loads only when requested and is pinned to a repository revision.

Save source configuration independently from testing its live connection. A compatible
Cardigann definition can be saved while its endpoint is unavailable or required
configuration is incomplete. Compatibility, configuration completeness, enablement,
and live verification are separate. Import and custom-source dialogs default to
disabled; enable a source explicitly when ready to search it.

Cardigann credentials and cookies require HTTPS. Current `links` represent mirrors
of one logical source. A working current mirror is reused; another current mirror
is tried only after connectivity failure. Empty searches, parsing/authentication
errors, and security rejection do not trigger mirror failover. `legacylinks` are
not promoted to current mirrors.

## Optional FlareSolverr transport

Only Cardigann definitions explicitly marked as requiring FlareSolverr use the
configured external service. Other definitions use direct HTTP. The service must
be configured on this computer or the private LAN; TorPlay never bundles it or
requires Docker. Missing configuration reports **Requires FlareSolverr**.

TorPlay validates request targets and reported final destinations and bounds
requests and responses. The external FlareSolverr service owns its internal
network requests and redirects. Deploy it with appropriate outbound network
restrictions. Torrent metadata downloads use TorPlay's direct guarded transport.

## Server boundary

The discovery entry point is `lib/sources/discovery.js`. It accepts media context
and cancellation, cache restoration, refresh, and progressive-update options, and
returns public candidates plus source diagnostics. Each source has an independent
120-second overall deadline. Empty results are successful searches, while failures
and timeouts remain visible separately. Successful sources survive other failures.

All source families use neutral normalization, relevance, deduplication, and ranking.
Optional unknown size/peer metadata remains unknown. Configured source identity and
upstream origin are distinct. TV episode matches rank ahead of valid season packs.

Public candidates contain display fields and temporary opaque IDs. They do not
contain hashes, magnets, download URLs, credentials, sessions, or raw provider
responses. Typed torrent/NZB private records expire after ten minutes. The server
resolves an ID with its expected kind before acquisition; unknown, wrong-kind, or
expired IDs require another search. These IDs are not media-library identity.

Torrent suitability inspection belongs to acquisition, outside Sources. The search
HTTP route composes discovery with that inspection to preserve the existing
**Checking torrent**, **Streamable**, and verify-on-start behavior. Torrent/Debrid
sessions, NZB jobs, and playback retain their existing owners.

Cached restoration and **Refresh torrents** remain available. A single private
24-hour cache stores replayable hash-based torrent data, never provider URLs,
credentials, cookies, or executable resolvers. Restored results receive new opaque
IDs. Source configuration changes change the cache identity. Restored previews are
not presented as verified torrent files.

## Configuration upgrades and diagnostics

Existing native/custom source files and stable IDs are retained. Legacy records
are represented by the new model without rewriting files during reads. The next
source configuration write commits representable migration atomically per file.
Unsafe/unrepresentable records produce explicit configuration diagnostics rather
than resetting the source list. Missing legacy service settings remain visible as
a migration error.

Source statuses distinguish disabled, ready, configuration required, unsupported,
requires FlareSolverr, unavailable, timed out, authentication failed, and invalid
response. Diagnostics and logs never expose raw source URLs or credentials.

Developers can inspect a locally supplied Cardigann v11 corpus using:

```sh
npm run audit:cardigann -- /path/to/definitions/v11
```

Only search and acquire content you are authorized to access.
