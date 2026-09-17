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
        +--> Jackett Torznab search --> indexers / FlareSolverr
        +--> WebTorrent session manager --> torrent swarm
        +--> subtitle providers and torrent sidecars
        +--> native Range stream or FFmpeg-prepared playback
```

This boundary keeps the reusable APIs suitable for another trusted client, such as a future Android TV application, without moving torrent or provider secrets into that client.

## Technology

| Area | Technology |
| --- | --- |
| Web app | Next.js App Router, React, JavaScript |
| Styling | Plain CSS |
| Persistence | SQLite through `better-sqlite3` |
| Metadata | TMDB API |
| Source search | Jackett Torznab API, Fast XML Parser |
| Search support | Docker Compose, Jackett, FlareSolverr, optional OMDb |
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
lib/search/           Jackett integration, ranking, validation, result storage
lib/subtitles/        Providers, cache, conversion, selection, appearance
lib/torrent/          Torrent validation, sessions, files, pieces, cleanup
lib/video/            Range handling, episode matching, probing, conversion
scripts/              Development, home runtime, Windows control, release tooling
installer/windows/    Inno Setup definition and installed-runtime assets
tests/                Unit and integration tests
docs/                 Current guides and historical task specifications
```

The browser-facing application never imports or controls the torrent client directly.

## Search flow

TMDB provides title metadata and discovery. Selecting a movie or episode starts a separate server-side Jackett search. TorPlay queries media-specific indexers, normalizes results, validates torrent metadata where possible, hides proven-incompatible sources, and keeps credential-bearing download URLs in an expiring server-side result store.

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

Temporary torrent files, subtitle caches, and conversion outputs are separate from persistent data. Docker named volumes retain Jackett and FlareSolverr configuration.

## Runtime variants

- `npm run dev` starts Compose dependencies and the Next.js development server.
- `npm start` starts a conventional production Next.js build.
- `npm run start:home` adds the Windows supervisor, Docker orchestration, port 80, and mDNS to a source checkout.
- The Windows installer packages a standalone Next.js build and bundled Node runtime around the same supervisor and Compose architecture.

All variants preserve the same API, playback, profile, search, and persistence behavior.
