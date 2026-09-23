# Development

## Prerequisites

- Node.js 20.9 or newer
- npm
- Permission to download and view the selected content

TorPlay requires a persistent Node.js process. It is not designed for serverless or multi-instance deployment.

## Setup

```bash
npm install
npm run dev
```

Open TorPlay and complete the browser setup; a `.env.local` file and restart are not required:

- TorPlay: [http://localhost:3000](http://localhost:3000)

Setup requires only TMDB. Torrent sources are optional and none are added automatically: add a TorPlay Tested Source, explore community Cardigann indexers, or configure a custom Torznab endpoint. Jackett is an optional external service configured under **Settings → Services**; its configured indexers can then be added individually under **Torrent Sources**. Prowlarr can be used as a custom Torznab endpoint.

## Development runtime

`npm run dev` starts only the Next.js development server. TorPlay does not install, start, stop, configure, or monitor Docker or external provider applications. Press Ctrl+C to stop the server.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run icons:generate` | Regenerate browser and Windows icons from the canonical TorPlay artwork |
| `npm run dev` | Start the Next.js development server |
| `npm run build` | Create the standard production build |
| `npm start` | Run the standard production build |
| `npm run start:home` | Run the manual Windows LAN supervisor after a build |
| `npm run firewall:home` | Add manual-runtime Windows firewall rules |
| `npm run release:windows` | Create the complete Windows installer on Windows x64 |
| `npm run release:linux` | Create the standalone AppImage on Linux x86_64 |
| `npm test` | Run Node.js unit and integration tests |
| `npm run lint` | Run ESLint |

## Build the Windows installer

Windows release builds must run on Windows x64 so SQLite, FFmpeg, and FFprobe native files match the target platform. The release workstation needs Node.js/npm, Inno Setup 7.1.0, and network access to download the pinned Node.js runtime.

Run the **Windows installer** GitHub Actions workflow manually against the branch or tag to package. Pull requests and pushes do not trigger it. A tag build must use `v<package-version>`. Successful runs retain the versioned installer and SHA-256 file as one artifact for 14 days; the workflow does not create or update a GitHub Release automatically.

For a local Windows x64 build:

```powershell
npm install
npm run release:windows
```

Set `INNO_SETUP_COMPILER` to the full `ISCC.exe` path when Inno Setup is installed outside its standard locations. The release command runs tests and lint, builds standalone Next.js output, bundles the supervisor, verifies the pinned Node runtime, validates native files, and writes:

```text
dist\windows\TorPlay-Setup-<version>.exe
dist\windows\TorPlay-Setup-<version>.exe.sha256
```

The command rejects non-Windows and non-x64 hosts rather than producing an incompatible installer. Release maintainers upload the verified files to [TorPlay Releases](https://github.com/jovev961/torplay/releases) for end users.

## Build the Linux AppImage

Run `npm ci` and `npm run release:linux` on Ubuntu 24.04 x86_64. The command runs tests, lint, and a standalone production build; downloads checksum-pinned Node 24.21.0, appimagetool 1.9.1, and the static AppImage runtime; validates Linux native files and secret exclusion; then writes `dist/linux/TorPlay-<version>-x86_64.AppImage` and its `.sha256` file. It rejects other build architectures.

The **Linux AppImage** workflow runs for pull requests into `develop` and can also be started manually once it is available on the default branch. It uses an Ubuntu 24.04 runner and uploads these files as a CI artifact for 14 days. It does not publish a GitHub Release or bump the application version. Before a public release, smoke-test the AppImage on a clean Ubuntu 24.04 x86_64 desktop, including browser launch and Quit without installing runtime packages. See [Linux deployment](linux-deployment.md).

## Data during development

| Path | Purpose | Persistence |
| --- | --- | --- |
| `persistent-data/torplay.db` | Profiles, history, progress, writer state | Persistent, gitignored |
| `native-sources.json` and `torrent-providers.json` beside the runtime configuration file | Added Tested Sources and custom/Jackett/Cardigann sources | Persistent, private, gitignored |
| `.data/torrents` | Managed torrent session files | Temporary, gitignored |
| `.data/subtitles` | Subtitle cache | Re-creatable, gitignored, automatically expires after the configured retention period |
| OS temporary directory | HLS and subtitle-conversion jobs | Temporary |

Do not point `TORRENT_DOWNLOAD_PATH` at a directory containing personal files. TorPlay owns and cleans info-hash directories under that path.

## Quality checks

Before completing a change, run:

```bash
npm test
npm run lint
npm run build
```

Tests that open loopback ports or start WebTorrent may require a normal local shell when a restricted sandbox blocks socket binding.

## Contribution boundaries

- Keep browser clients away from Jackett credentials, magnets, torrent metadata downloads, swarm connections, and provider keys.
- Keep torrent streaming server-side and preserve HTTP Range semantics.
- Preserve the separation between `app/`, `components/`, and `lib/` described in [Architecture](architecture.md).
- Keep generated data outside source control.
- Do not add authentication, databases beyond the existing SQLite store, or alternative streaming stacks without an explicit task.
- Keep external provider applications user-operated; TorPlay should not install or manage them.

The root `AGENTS.md` contains the complete repository-specific implementation rules.
