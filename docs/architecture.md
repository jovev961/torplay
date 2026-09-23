# Architecture

## Security and runtime boundary

The browser communicates only with TorPlay pages and API routes. Provider credentials, credential-bearing torrent URLs, magnets, metadata downloads, swarm connections, file selection, media conversion, and persistent watch data stay on the server. An optional playback resolver checks ready Real-Debrid or TorBox files after source selection, then applies the saved local-or-remote choice. Remote jobs are tracked by safe SQLite resource references and reconciled with the provider account; Debrid Library reads provider state. Ready files use the existing secure session-scoped Range proxy.

```text
Browser / future client
        |
        v
Next.js pages and API routes
        |
        +--> TMDB metadata and catalog discovery --> optional OMDb IMDb ratings
        +--> SQLite profiles, history, and progress
        +--> Torrent search service --> TorPlay Tested Sources (optional)
        |                          +--> Community Sources (Cardigann v11)
        |                          |    +--> direct HTTP or optional FlareSolverr when marked
        |                          +--> Custom Indexers (Torznab-compatible)
        |                               +--> external Jackett indexers or Prowlarr endpoints
        +--> WebTorrent session manager --> torrent swarm
        +--> subtitle providers and torrent sidecars
        +--> native Range stream or FFmpeg-prepared playback
        +--> Cast / AirPlay receiver --> TorPlay HTTP media and subtitle routes
```

This boundary keeps the reusable APIs suitable for another trusted client, such as a future Android TV application, without moving torrent or provider secrets into that client.

## Core and platform boundaries

TorPlay core lives under `lib/` and is organized by capability. It contains no Next.js imports and does not depend on application, UI, runtime-script, or operating-system adapter directories.

| Core capability | Boundary |
| --- | --- |
| Configuration | `lib/settings/` |
| Metadata | `lib/metadata/` |
| Torrent search | `lib/search/` |
| Torrent engine | `lib/torrent/` and `lib/video/` |
| Subtitle providers | `lib/subtitles/` |
| Profiles | `lib/profiles/` |
| Playback state | `lib/history/` and `lib/playback/` |

Platform adapters depend inward on these services:

```text
Next.js pages and routes (app/) ──┐
React UI (components/) ───────────┼──> TorPlay core (lib/)
Runtime adapters (platform/) ─────┤
Process entry points (scripts/) ──┘
```

Next.js-only setup redirects and settings-response composition stay in `app/_lib/`. Runtime status-file persistence stays in `platform/runtime/`. The automated architecture-boundary test prevents core modules from importing these outer layers.

## Technology

| Area | Technology |
| --- | --- |
| Web app | Next.js App Router, React, JavaScript |
| Styling | Plain CSS |
| Persistence | SQLite through `better-sqlite3` |
| Metadata | TMDB API |
| Source search | Provider-independent adapters, Cardigann definitions, Torznab XML through Fast XML Parser |
| Search support | Optional Tested Sources, Cardigann and Torznab sources; FlareSolverr for marked Cardigann definitions |
| Torrent runtime | WebTorrent and `parse-torrent` |
| Playback | HTML5 video, HTTP Range, HLS.js |
| Conversion | FFmpeg and FFprobe static packages |
| Subtitles | WebVTT, `chardet`, OpenSubtitles, SubDL |
| Local discovery | Port-80 reverse proxy and mDNS through `@homebridge/ciao` |

## Project structure

```text
app/                  Pages and API route handlers
components/           Reusable catalog, profile, source, and player UI
lib/database/         SQLite connection and schema migration
lib/history/          Progress, completion, grouping, and history rules
lib/metadata/         TMDB client and catalog normalization
lib/playback/         Next-episode and autoplay orchestration
lib/profiles/         Profile persistence
lib/search/           Shared search processing, provider selection, adapters, result storage
lib/subtitles/        Providers, cache, conversion, selection, appearance
lib/torrent/          Torrent validation, sessions, files, pieces, cleanup
lib/video/            Range handling, episode matching, probing, conversion
platform/runtime/     Host runtime status persistence adapter
scripts/              Development and platform process entry points, Windows control, release tooling
installer/windows/    Inno Setup definition and installed-runtime assets
tests/                Unit and integration tests
docs/                 Current guides and historical task specifications
```

The browser-facing application never imports or controls the torrent client directly.

## Search flow

TMDB provides title metadata and discovery; optional OMDb data supplies IMDb ratings independently of torrent search. Selecting a movie or episode calls the server-side torrent search service. Provider selection is isolated in `lib/search/provider.js`. Users explicitly add optional TorPlay Tested Sources, community Cardigann definitions, or custom Torznab-compatible endpoints. Jackett is an external service whose configured indexers are added individually after its credentials are validated; Prowlarr is supported through a custom Torznab endpoint. No source is added automatically. The community definition directory is loaded on demand, not bundled as an enabled catalog.

Adapters implement the [common provider contract](torrent-providers.md) and execute concurrently. Their candidates are normalized while individual provider failures remain isolated. Shared processing validates search context, filters titles and episodes, deduplicates, and ranks candidates using the existing rules. The service allocates expiring result IDs and validates streamability before returning an explicit public projection. Magnets and credential-bearing download URLs remain in the server-side result store. Search routes and automatic next-episode playback use the same service without importing adapters. When no provider is available, the application directs the user to provider settings instead of requiring Jackett.

## Torrent lifecycle

- Magnet links, torrent input, result IDs, torrent IDs, and file IDs are validated.
- Search inspects up to the top 20 relevant seed-ranked candidates with bounded concurrency.
- Selected files acquire reference-counted piece leases for active viewers.
- A distant seek replaces only that viewer's buffer-ahead lease.
- Leaving a page releases its session; abandoned sessions expire after two minutes.
- The final viewer releases the torrent and deletes its app-owned info-hash directory.
- When the final torrent resource is released, TorPlay also stops its cleanup timer and destroys the idle WebTorrent client, peer connections, DHT activity, and media server. A later playback request creates them again.
- Startup removes leftover app-owned torrent directories.

The browser receives opaque routes and status, never swarm access.

## Background resource usage

TorPlay does not run recurring external-provider or health checks while sitting on ordinary pages. Opening Settings validates only the currently viewed provider section, with short server-side health caching; General, Playback, and About make no provider requests. Torrent metadata status is polled once per second only while metadata is loading, instead of continuing after the session becomes ready. Subtitle discovery polls only while its bounded provider work is pending, playback progress is saved only while video is playing, and HLS status polling ends when conversion completes or the player unmounts.

Before this optimization, every ready source session generated one status request per second and kept its activity timestamp fresh, and the WebTorrent runtime plus a minute cleanup interval stayed alive after the final viewer left. The lifecycle and settings-navigation tests now assert the idle behavior so future changes do not silently restore that background work.

## Playback pipeline

Native MP4, M4V, and WebM files are served with correct full and partial HTTP responses. Range parsing supports bounded, open-ended, and suffix requests and rejects malformed or unsatisfiable ranges.

Other recognized containers are probed with FFprobe and remuxed or transcoded to H.264/AAC playback when needed. Conversion starts only when playback is requested, consumes more CPU, and does not currently provide arbitrary seeking.

Subtitles may come from torrent sidecars, embedded streams, OpenSubtitles, or SubDL. Server code converts supported text to WebVTT and exposes tracks through opaque application routes.

Remote playback is transport-neutral at the media boundary. The player builds a receiver-safe source descriptor containing only absolute TorPlay media and subtitle URLs, then a browser adapter loads it on Google Cast or invokes the native AirPlay picker. Receivers fetch media directly from the LAN server; they never receive magnets, provider credentials, or a torrent client. Active receiver sessions keep the associated torrent and conversion resources available until playback stops or normal server expiry applies.

## Persistence

SQLite stores local profiles, progress, history, and stale-writer protection. Media identity is based on profile plus TMDB title/episode identity rather than torrent identity. Writer tokens and monotonically increasing sequences prevent older players or delayed requests from overwriting current progress.

Temporary torrent files, subtitle caches, and conversion outputs are separate from persistent data. Added Tested Sources and custom, Jackett, and Cardigann source records stay in private server-side files. External provider applications retain and manage their own data independently of TorPlay.

Public external response data uses a best-effort SQLite cache. TMDB search results expire after 5 minutes, discovery results after 15 minutes, ordinary metadata after 1 hour, genres after 24 hours, and external IDs after 30 days. Safely reusable torrent-provider results expire after 2 minutes, while remote subtitle-language catalogs expire after 24 hours. IMDb ratings retain their existing 30-day policy. Expired or corrupt entries are ignored and removed; cache read/write failures fall back to the external service. Provider results are persisted only when they can be reduced to canonical info-hash magnets, so API keys, authenticated download URLs, tracker passkeys, and other credentials are never written to the response cache.

## Runtime variants

- `npm run dev` starts the Next.js development server and does not manage external provider processes.
- `npm start` starts a conventional production Next.js build.
- `npm run start:home` adds the Windows supervisor, port 80, and mDNS to a source checkout.
- The Windows installer packages a standalone Next.js build and bundled Node runtime around the same supervisor without Docker Desktop or containers.

The Windows supervisor health-checks the application server, LAN proxy, and mDNS advertisement after startup. It restarts a failed component independently when safe, but permits only three recovery attempts per component in a 60-second window. A component that keeps failing is left in an explicit error state for manual retry instead of entering an uncontrolled restart loop.

All variants preserve the same API, playback, profile, search, and persistence behavior.
