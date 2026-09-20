# Architecture

## Security and runtime boundary

The browser communicates only with TorPlay pages and API routes. Provider credentials, credential-bearing torrent URLs, magnets, metadata downloads, swarm connections, file selection, media conversion, and persistent watch data stay on the server.

```text
Browser / future client
        |
        v
Next.js pages and API routes
        |
        +--> TMDB metadata and catalog discovery
        +--> SQLite profiles, history, and progress
        +--> Torrent search service --> native JSON providers
        |                          +--> custom Torznab providers
        |                          +--> optional Jackett adapter
        +--> WebTorrent session manager --> torrent swarm
        +--> subtitle providers and torrent sidecars
        +--> native Range stream or FFmpeg-prepared playback
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
| Source search | Provider-independent adapters, native JSON APIs, Torznab XML through Fast XML Parser |
| Search support | Native providers, optional custom Torznab/Jackett, optional OMDb |
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

TMDB provides title metadata and discovery. Selecting a movie or episode calls the server-side torrent search service. Provider selection is isolated in `lib/search/provider.js`. It selects configured adapters for the native YTS, Knaben, and EZTV providers, generic custom Torznab sources, and optional Jackett integration.

Adapters implement the [common provider contract](torrent-providers.md) and execute concurrently. Their candidates are normalized while individual provider failures remain isolated. Shared processing validates search context, filters titles and episodes, deduplicates, and ranks candidates using the existing rules. The service allocates expiring result IDs and validates streamability before returning an explicit public projection. Magnets and credential-bearing download URLs remain in the server-side result store. Search routes and automatic next-episode playback use the same service without importing adapters. When no provider is available, the application directs the user to provider settings instead of requiring Jackett.

## Torrent lifecycle

- Magnet links, torrent input, result IDs, torrent IDs, and file IDs are validated.
- Search inspects up to the top 20 relevant seed-ranked candidates with bounded concurrency.
- Selected files acquire reference-counted piece leases for active viewers.
- A distant seek replaces only that viewer's buffer-ahead lease.
- Leaving a page releases its session; abandoned sessions expire after two minutes.
- The final viewer releases the torrent and deletes its app-owned info-hash directory.
- Startup removes leftover app-owned torrent directories.

The browser receives opaque routes and status, never swarm access.

## Playback pipeline

Native MP4, M4V, and WebM files are served with correct full and partial HTTP responses. Range parsing supports bounded, open-ended, and suffix requests and rejects malformed or unsatisfiable ranges.

Other recognized containers are probed with FFprobe and remuxed or transcoded to H.264/AAC playback when needed. Conversion starts only when playback is requested, consumes more CPU, and does not currently provide arbitrary seeking.

Subtitles may come from torrent sidecars, embedded streams, OpenSubtitles, or SubDL. Server code converts supported text to WebVTT and exposes tracks through opaque application routes.

## Persistence

SQLite stores local profiles, progress, history, and stale-writer protection. Media identity is based on profile plus TMDB title/episode identity rather than torrent identity. Writer tokens and monotonically increasing sequences prevent older players or delayed requests from overwriting current progress.

Temporary torrent files, subtitle caches, and conversion outputs are separate from persistent data. Custom Torznab configuration stays in a private server-side file. External provider applications retain and manage their own data independently of TorPlay.

Public external response data uses a best-effort SQLite cache. TMDB search results expire after 5 minutes, discovery results after 15 minutes, ordinary metadata after 1 hour, genres after 24 hours, and external IDs after 30 days. Safely reusable torrent-provider results expire after 2 minutes, while remote subtitle-language catalogs expire after 24 hours. IMDb ratings retain their existing 30-day policy. Expired or corrupt entries are ignored and removed; cache read/write failures fall back to the external service. Provider results are persisted only when they can be reduced to canonical info-hash magnets, so API keys, authenticated download URLs, tracker passkeys, and other credentials are never written to the response cache.

## Runtime variants

- `npm run dev` starts the Next.js development server and does not manage external provider processes.
- `npm start` starts a conventional production Next.js build.
- `npm run start:home` adds the Windows supervisor, port 80, and mDNS to a source checkout.
- The Windows installer packages a standalone Next.js build and bundled Node runtime around the same supervisor without Docker Desktop or containers.

All variants preserve the same API, playback, profile, search, and persistence behavior.
