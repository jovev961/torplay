# Configuration

TorPlay configuration is server-only. Never expose provider keys, Jackett download URLs, magnets, or torrent credentials to browser code.

## Configuration files

- Development and source runtime: `.env.local` when advanced manual configuration is desired
- Installed Windows runtime: `%LOCALAPPDATA%\TorPlay\config\torplay.env`

On a fresh launch, TorPlay redirects provider-dependent pages to **Setup** to validate and save TMDB. Afterwards, open **Settings → Torrent Sources** to explicitly add an optional TorPlay Tested Source, explore community Cardigann definitions, or add a custom Torznab endpoint. No torrent source is added automatically. Optional services and subtitles have their own Settings sections. Setup and Settings can be changed through `localhost`, the configured `.local` hostname, or a private LAN address. A blank secret input keeps the configured value, while **Remove** explicitly deletes it.

TorPlay stores service Settings in the runtime configuration file and source choices in adjacent private files. Writes are atomic, with restricted permissions where the operating system supports them. Credentials supplied by the host environment remain read-only. Provider changes take effect immediately. Do not commit real credentials.

## Optional debrid playback

Open **Settings → Services** to connect Real-Debrid or TorBox and choose which provider TorPlay checks first. Both providers accept a manually entered API key or their device authorization flow. Open **Settings → Playback** to choose a method. **Local BitTorrent Only** is the default and makes no debrid calls. **Prefer Debrid** checks the preferred provider first, then the other provider; if neither has the requested file, it uses local BitTorrent when local fallback is enabled. **Debrid Only** never starts a local torrent. Debrid services are playback backends, not torrent sources; keep your existing source choices.

TorPlay uses only immediately available remote files. A TorBox cache hit may create an account resource with TorBox's cached-only flag before requesting the exact movie or episode file. Real-Debrid's documented API does not currently provide a global cache lookup, so TorPlay uses a matching **completed torrent already in your account** and skips unknown hashes. An uncached result continues to the next backend under your selected method; TorPlay does not start an uncached remote download. Multi-file packs are matched by the requested episode, and an ambiguous match is never selected automatically.

Real-Debrid's device authorization remains available; its manual field accepts the private API token from your Real-Debrid account. A manual token does not use OAuth refresh, and disconnect removes it from TorPlay; revoke it on the provider site if needed. TorBox supports device authorization and a manually entered API key. New keys are tested before replacing an existing credential. Connection and test status are shown without returning credentials to the browser. TorPlay stores debrid credentials and playback policy in a private, atomic `debrid-config.json` beside the runtime configuration file; in development this is beside `.env.local`, and in installed Windows or Linux runtimes it is in the persistent configuration directory. Keep that file in private backups and never commit it. TorBox requires an API token in its download-link request; TorPlay sends it only to TorBox from the server, never to the browser or logs. The browser and LAN receivers stream through TorPlay's session URLs.

Neither TorPlay nor a debrid connection includes a provider subscription or guarantees a torrent is cached. Connecting a provider does not change the legal status of content.

## Required providers

Create a TMDB account, follow the official [TMDB API getting-started guide](https://developer.themoviedb.org/docs/getting-started), and copy the **API Read Access Token** from [TMDB API settings](https://www.themoviedb.org/settings/api). TorPlay does not accept the shorter v3 API key in this field.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `TMDB_API_TOKEN` | Yes | None | TMDB API Read Access Token used for metadata. A v3 API key is not accepted here. |

## Search and optional services

OMDb is optional and used directly by TorPlay for IMDb ratings; it is not a Jackett integration. Request a key from the official [OMDb API key page](https://www.omdbapi.com/apikey.aspx). Jackett is an optional externally run service: configure and test its URL and API key under **Settings → Services**, then add individual configured indexers under **Torrent Sources**. Prowlarr remains available as a custom Torznab source. FlareSolverr is optional for Cardigann definitions marked `info_flaresolverr`; it is not needed for other source types.

| Variable | Default | Description |
| --- | --- | --- |
| `JACKETT_URL` | Unset | Base URL of an independently operated Jackett service. |
| `JACKETT_API_KEY` | Unset | Server-only Jackett API key. |
| `FLARESOLVERR_URL` | Unset | URL of an external FlareSolverr service on this computer or a private LAN, such as `http://localhost:8191`. |
| `OMDB_API_KEY` | Unset | Optional server-side OMDb key used for IMDb ratings on catalog cards and metadata lookups. Ratings are omitted when absent. |
| `TORPLAY_SEARCH_PROVIDERS` | Unset | Optional full-provider allowlist using stable source IDs. A legacy `jackett` entry still selects Jackett sources. |

Added TorPlay Tested Sources are stored in `native-sources.json`; custom Torznab, Jackett, and imported Cardigann sources are stored in `torrent-providers.json`. Both files sit beside `.env.local` or the installed `torplay.env`. Jackett sources reference the Services credentials rather than copying the key. For Cardigann sources, the private file includes the complete imported YAML and its integrity hash. These files can contain other API keys and settings; keep them out of source control and include them only in private backups. Settings writes them atomically with restrictive file permissions where supported. New custom endpoints and changed credentials must pass validation before saving. Cardigann import checks definition compatibility and attempts a live search; if only connection verification fails, the UI can explicitly save the source with **Add Anyway** and mark it unverified. Edits take effect immediately. Old `JACKETT_MOVIE_INDEXERS` and `JACKETT_SHOW_INDEXERS` values are read only to migrate older installations into individual source records; they are no longer used by search.

Every explicitly named Jackett indexer must already be enabled and configured in Jackett. TorPlay queries configured providers independently and retains results from healthy sources when another fails. Custom and imported source health can be refreshed from Settings.

**Required** and **Optional** in Services describe whether TorPlay needs the service for setup, not whether every source can use it. An optional service shows **Unconfigured** until its values are supplied; validation can then report a verified connection, invalid values, or an unreachable service. A Cardigann source marked for FlareSolverr depends on that service for its own searches, while other sources do not. In Torrent Sources, **Disabled** means the source is not searched; **Unavailable** means its current connection or search could not be verified. An explicitly added unverified Cardigann source should be tested again after its indexer and optional service settings are corrected.

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

External subtitle services are optional. Obtain credentials through the official [OpenSubtitles API consumers](https://www.opensubtitles.com/en/consumers) or [SubDL API panel](https://subdl.com/panel/api).

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

If `TORPLAY_PUBLIC_PORT` is changed for the manual source runtime, recreate its firewall rule with the same port. The packaged installer is designed for port 80.

## Release workstation

| Variable | Default | Description |
| --- | --- | --- |
| `INNO_SETUP_COMPILER` | Standard Inno Setup 7 locations | Full path to `ISCC.exe` when installed elsewhere. |
| `TORPLAY_STANDALONE_BUILD` | Unset | Internal release flag used by `npm run release:windows`; do not set for ordinary builds. |

Variables such as `TORPLAY_INSTALL_DIR`, `TORPLAY_DATA_DIR`, `TORPLAY_SERVER_ENTRY`, `TORPLAY_RUNTIME_DIR`, `TORPLAY_STATUS_PATH`, `TORPLAY_LOG_PATH`, and `TORPLAY_CONTROL_ENDPOINT` are installer/runtime integration details. The Windows launcher supplies them automatically and normal users should not add them to `torplay.env`.
