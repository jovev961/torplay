# Sources/Search replacement — development inventory

Primary task: `docs/tasks/develop/torplay-develop-reinvent-sources-search.md`.
Tracking issue: #145. This is implementation documentation, not independent verification.

## Boundary inventory

| Existing area | Classification | Replacement responsibility |
| --- | --- | --- |
| Search provider selection, service, processing, contract, result store | OLD SOURCE IMPLEMENTATION — REMOVE | Sources configuration, discovery, relevance, private results |
| Native integrations, Torznab/XML, Jackett source helpers | OLD SOURCE IMPLEMENTATION — REMOVE | Small family adapters and configuration operations |
| Cardigann definition/execution/template/filter/transport code | OLD SOURCE IMPLEMENTATION — REMOVE | Definition-driven interpreter and explicit capability reporting |
| Community directory and import state | OLD SOURCE IMPLEMENTATION — REMOVE | Bounded definition browsing/import |
| Source-specific settings modules | OLD SOURCE IMPLEMENTATION — REMOVE | Sources-owned configuration semantics using existing file formats |
| Torrent streamability inspection | EXTERNAL CONTRACT — MIGRATE | Acquisition-owned inspection coordinator |
| SQLite/cache, settings write queue, request authorization, media identity | GENERIC TORPLAY FOUNDATION — KEEP | Existing owners |
| Destination validation and bounded HTTP behavior | GENERIC TORPLAY FOUNDATION — KEEP POLICY | Consolidated network implementation outside Sources |
| Usenet search ranking/result storage reuse | EXTERNAL CONTRACT — MIGRATE | Neutral relevance and typed private results; jobs unchanged |

## Consumer map

| Consumer | Existing dependency | Actual need / replacement |
| --- | --- | --- |
| Movie/TV selection hook and panel | Search JSON/NDJSON, inspection fields, result IDs | Preserve route formats; safe candidates with source/origin and acquisition inspection |
| Torrent start route | Untyped stored source | Typed private torrent descriptor resolved on the server |
| Debrid availability | Stored hash/locator/context | Typed private torrent descriptor; existing availability logic |
| Next episode | Active session reuse / manual search | Preserve; no discovery-owned playback startup |
| Source settings/onboarding | Family-specific settings helpers | Sources configuration boundary; enablement, compatibility, configuration and verification separated |
| Usenet search/start | Torrent processing and untyped result store | Neutral relevance and NZB-kind result resolution; jobs unchanged |
| Settings service validation | Source-local transport/service helpers | Shared network policy and generic Torznab service operations |
| Cardigann audit scripts | Old definition/filter exports | Replacement capability boundary |

## Intended ownership

```text
Sources configuration → family adapters → discovery/relevance
                                         ↓
                         public candidates + private result records
                                         ↓
                  acquisition inspection → existing acquisition/playback
```

Cached restoration and Refresh remain available. Only replayable hash-based
torrent data is persisted, using the generic private SQLite cache. Private
download URLs, credentials, sessions, and resolver functions are not persisted
in that cache. Results use temporary opaque IDs, not library identity.

FlareSolverr is an explicitly configured local/LAN service. TorPlay validates
targets and reported final destinations; the external service owns its internal
requests and redirects. Direct HTTP validates and pins every destination.

Old subsystem tests are deliberately left untouched in Develop mode. Fresh Test
must replace subsystem-owned tests from the original requirements; obsolete test
imports are not a reason to retain production compatibility modules.
