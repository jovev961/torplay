# Configuration

TorPlay configuration is server-only. Never expose provider keys, Jackett download URLs, magnets, or torrent credentials to browser code.

## Configuration files

- Development and source runtime: `.env.local`, created from `.env.local.example`
- Installed Windows runtime: `%LOCALAPPDATA%\TorPlay\config\torplay.env`

Restart the relevant TorPlay runtime after changing either file. Do not commit real credentials.

## Required providers

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `TMDB_API_TOKEN` | Yes | None | TMDB API Read Access Token used for metadata. A v3 API key is not accepted here. |
| `JACKETT_URL` | Yes for source search | `http://localhost:9117` in templates | Jackett base URL. Must use HTTP or HTTPS. |
| `JACKETT_API_KEY` | Yes for source search | None | API key shown in the Jackett dashboard. |

## Search and Jackett

| Variable | Default | Description |
| --- | --- | --- |
| `JACKETT_MOVIE_INDEXERS` | Template-defined list | Comma-separated Jackett IDs used for movies. Empty searches all configured indexers. |
| `JACKETT_SHOW_INDEXERS` | Template-defined list | Comma-separated Jackett IDs used for shows. Empty searches all configured indexers. |
| `OMDB_API_KEY` | Unset | Optional server-side OMDb key used for IMDb ratings on catalog cards and copied into Jackett for IMDb-only aggregate-search fallback. Ratings are omitted when absent; TorPlay preserves Jackett's existing key. |

Every explicitly named indexer must already be enabled and configured in Jackett. TorPlay queries media-specific lists independently and retains results from healthy indexers when another fails.

## Persistent and temporary storage

| Variable | Development default | Installed default | Description |
| --- | --- | --- | --- |
| `TORPLAY_DATABASE_PATH` | `persistent-data/torplay.db` | `%LOCALAPPDATA%\TorPlay\data\torplay.db` | SQLite profiles, history, progress, and writer state. |
| `TORRENT_DOWNLOAD_PATH` | `.data/torrents` | `%LOCALAPPDATA%\TorPlay\cache\torrents` | App-owned temporary torrent data. |
| `SUBTITLE_CACHE_PATH` | `.data/subtitles` | `%LOCALAPPDATA%\TorPlay\cache\subtitles` | Re-creatable subtitle cache. |

Relative paths resolve from the runtime working directory. Absolute paths are recommended for overrides in an installed deployment.

## Torrent behavior

| Variable | Default | Description |
| --- | --- | --- |
| `TORRENT_TRACKERS` | TorPlay's public fallback list | Comma-separated HTTP, HTTPS, UDP, or WebSocket tracker URLs. Use `none` to disable fallback trackers. |

Fallback trackers supplement torrent-provided trackers and DHT. They do not make an unavailable torrent healthy and do not change the selected content.

## Media tools and playback

| Variable | Default | Description |
| --- | --- | --- |
| `FFMPEG_PATH` | Bundled `ffmpeg-static` executable | Optional absolute FFmpeg override. |
| `FFPROBE_PATH` | Bundled `ffprobe-static` executable | Optional absolute FFprobe override. |
| `PLAYBACK_BUFFER_AHEAD_SECONDS` | `60` | Positive target buffer duration used by playback and subtitle configuration. |

MP4, M4V, and WebM use native browser playback with HTTP Range seeking. Other recognized containers use FFmpeg-prepared H.264/AAC playback when needed.

## Subtitles

| Variable | Default | Description |
| --- | --- | --- |
| `SUBTITLE_CACHE_TTL_DAYS` | `30` | Days since last use before a cached subtitle becomes eligible for automatic cleanup. |
| `OPENSUBTITLES_API_KEY` | Unset | Optional OpenSubtitles API key. |
| `OPENSUBTITLES_USER_AGENT` | `TorPlay v0.1` | User agent supplied to OpenSubtitles. |
| `SUBDL_API_KEY` | Unset | Optional SubDL API key. |

Torrent and embedded subtitles continue to work without external subtitle-provider keys.
Preferred and primary subtitle languages are configured per profile from **Manage Profiles → Subtitles**. They are stored in TorPlay's local database and take effect without restarting the app. Existing profile language values from the removed environment variables are imported once during the database migration.

## Windows home network runtime

| Variable | Default | Description |
| --- | --- | --- |
| `TORPLAY_HOST` | `127.0.0.1` | Private Next.js bind host; accepts `127.0.0.1`, `localhost`, or `0.0.0.0`. |
| `TORPLAY_PORT` | `3000` | Internal Next.js port. |
| `TORPLAY_PUBLIC_HOSTNAME` | `torplay.local` | Single valid `.local` hostname advertised over mDNS. |
| `TORPLAY_PUBLIC_PORT` | `80` | LAN-facing proxy port; must differ from `TORPLAY_PORT`. |
| `TORPLAY_MDNS_INTERFACE` | Automatic | Optional Windows interface name or local address for systems with confusing VPN/virtual adapters. |
| `TORPLAY_DOCKER_WAIT_SECONDS` | `600` installed, immediate failure in manual source mode | Maximum installed-runtime wait for Docker readiness. |
| `DOCKER_CLI_PATH` | Auto-detected | Optional Docker CLI path override. |
| `DOCKER_DESKTOP_PATH` | Auto-detected | Optional Docker Desktop executable path override. |

If `TORPLAY_PUBLIC_PORT` is changed for the manual source runtime, recreate its firewall rule with the same port. The packaged installer is designed for port 80.

## Release workstation

| Variable | Default | Description |
| --- | --- | --- |
| `INNO_SETUP_COMPILER` | Standard Inno Setup 7 locations | Full path to `ISCC.exe` when installed elsewhere. |
| `TORPLAY_STANDALONE_BUILD` | Unset | Internal release flag used by `npm run release:windows`; do not set for ordinary builds. |

Variables such as `TORPLAY_INSTALL_DIR`, `TORPLAY_DATA_DIR`, `TORPLAY_SERVER_ENTRY`, `TORPLAY_RUNTIME_DIR`, `TORPLAY_STATUS_PATH`, `TORPLAY_LOG_PATH`, and `TORPLAY_CONTROL_ENDPOINT` are installer/runtime integration details. The Windows launcher supplies them automatically and normal users should not add them to `torplay.env`.
