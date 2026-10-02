# Sources/Search development report

Task: `docs/tasks/develop/torplay-develop-reinvent-sources-search.md`.
Issue: [#145](https://github.com/jovev961/torplay/issues/145).
Branch: `develop`. No local commit, push, deployment, or issue closure.
This records development work; independent Test and Review are still required.

## Implementation

The old `lib/search` runtime and the two source-specific settings modules were
removed. The upstream Cardigann v11 schema remains as data under the replacement.
[The inventory](sources-search-reinvention.md) classifies removed code, retained
foundations, and every consumer boundary.

`lib/sources` owns configuration, family execution, relevance, discovery, and
private result resolution. Native integrations, custom Torznab and service-linked
indexers feed the same normalization contract. Cardigann uses a definition-driven
interpreter with bounded templates, selectors, filters, authentication, download
resolution, and explicit unsupported-feature reporting. Community browsing and
imports are bounded and do not enable sources automatically.

Compatibility, configuration readiness, and live verification are separate.
Compatible definitions can be saved offline or with incomplete credentials.
Saved identifiers and representable settings are retained; unsafe records are
reported rather than silently discarded. Fresh configuration has zero sources.
Explicit enablement is required for newly imported/custom sources. Configuration
reads do not write files; mutations use the shared write queue and atomic private
JSON persistence. Native mutations write the native file and any necessary legacy
migration; custom mutations do not rewrite native settings.

Search accepts validated media context and returns public candidates plus safe
diagnostics and cache state. Candidates expose an opaque ID, release attributes,
configured-source provenance, optional upstream origin, and acquisition inspection
state. They do not expose credentials, hashes, download URLs, or resolver functions.
Typed server-side resolution retains those private descriptors for ten minutes;
unknown, expired, and wrong-kind IDs are rejected by acquisition consumers.

Shared relevance uses Unicode/case/punctuation normalization, aliases, genuine
identity/type/year checks, episode and season-pack handling, conservative
deduplication, and deterministic ranking. It does not manufacture source-reported
identity from the requested title. Unknown seeders and size remain unknown.

Sources execute concurrently with isolated diagnostics, whole-operation deadlines,
and caller cancellation. Direct HTTP validates and pins destinations, validates
redirects, bounds compressed/decompressed responses, and restricts credential
forwarding. Explicit local services have a separate policy from external sources.
Cardigann uses current mirrors, sticky successful links, connectivity-only failover,
session cookies, and shared per-source request pacing. Empty results, authentication,
parsing, and security errors do not trigger mirror failover; legacy links are unused.
FlareSolverr is used only for explicit definition requirements and configured
endpoints, with a distinct missing-configuration diagnostic.

Cached restoration and Refresh are preserved. Persistent cache records contain
replayable hash-based data; URLs, cookies, credentials, and resolvers are excluded.
Cached records receive fresh temporary result IDs. Non-replayable cached results
are previews followed by discovery. Acquisition inspection now belongs to
`lib/torrent/source-inspection.js`; discovery does not own torrent sessions.

Usenet uses neutral media validation, relevance and typed private IDs. Its Newznab
execution, jobs, downloading and playback remain with their existing owners.
Torrent and Debrid routes resolve torrent-kind IDs; Usenet resolves NZB-kind IDs.
JSON/NDJSON search and settings routes, settings snapshots, onboarding, source
health, selection UI and audit scripts were migrated. Existing playback/session
contracts were retained. Outbound address classification is shared with the
existing Debrid transport without replacing that transport.

## Files

New production areas: `lib/sources/**`, `lib/network/request.js`,
`lib/settings/json-file.js`, `lib/torrent/source-inspection.js`.
Changed boundaries: search and source-settings routes, torrent/Usenet start routes,
settings snapshot/configuration/validation, Debrid availability/transport,
`lib/network/private-address.js`, Usenet search, source onboarding/management/panel
components and lookup hook, and Cardigann audit imports.
Documentation: this report, the inventory, and `docs/torrent-providers.md`.
Pre-existing unrelated workspace edits were preserved.

## Development checks

- Focused ESLint over all changed production boundaries and new modules: passed.
- `./node_modules/.bin/next build`: passed after final production changes.
- Module-import smoke and isolated empty configuration: passed; zero configured
  and active sources, with no configuration created on read.
- Manual route smoke with isolated configuration: JSON returned
  `503 NO_TORRENT_SOURCES`; NDJSON emitted started, Usenet, diagnostics, error and
  completion events. Template rendering smoke passed.
- `git diff --check`: passed.
- Production-import scan: no remaining imports of the removed subsystem.
- SHA-256 comparison of the entire tests tree against the starting workspace:
  unchanged. No tests were created, edited or executed in Develop mode.

The focused lint command covered `lib/sources`, network request/address modules,
JSON persistence, acquisition inspection, migrated API routes, settings modules,
source components/hook, Usenet search, Debrid modules, and both audit scripts.

## Limitations and independent handoff

Live native, community, Cardigann, Torznab and FlareSolverr services were not
verified during development. FlareSolverr owns intermediate redirects inside its
external process; TorPlay validates its initial target and reported final URL.
Existing acquisition engines own tracker/peer and subsequent playback traffic.
Source-ID storage is process-local and temporary. Obsolete subsystem test imports
were deliberately left unchanged; Test must derive replacement coverage from the
original requirements instead of retaining obsolete production modules.

Start a fresh session with:

```text
test docs/tasks/develop/torplay-develop-reinvent-sources-search.md
```

Use the primary task and issue as the source of expected behavior. Independently
cover fresh and migrated configuration, enablement/health/onboarding, supported and
unsupported definitions, all source families, relevance/dedup/ranking, provenance,
cache restoration/Refresh, opaque-ID expiry and kind enforcement, secret/locator
privacy, deadlines/cancellation/isolation, redirect/DNS/response boundaries,
mirror policy, explicit-only FlareSolverr, acquisition inspection, and preserved
Torrent/Debrid/Usenet/TV consumers. Derive the test plan before inspecting internals.
This report is not an acceptance oracle or approval.
