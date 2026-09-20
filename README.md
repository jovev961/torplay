# TorPlay

TorPlay is a self-hosted web app for discovering and streaming public-domain, Creative Commons, or otherwise authorized torrent video. Search, torrent traffic, media conversion, provider credentials, profiles, and watch history remain on the TorPlay computer; browsers connect only to the web app.

TorPlay includes movie and TV discovery, built-in torrent sources and optional Torznab providers, server-side WebTorrent streaming, profiles and Continue Watching, subtitles, autoplay, native HTTP Range playback, and FFmpeg-backed playback for additional video formats.

> Use TorPlay only with content you are legally permitted to download and view.

## Deploy on Windows

The recommended household deployment is the TorPlay Windows installer.

Requirements:

- Windows 10 or 11 x64
- A TMDB API Read Access Token

Installation:

1. Run `TorPlay-Setup-<version>.exe`.
2. Choose **Open TorPlay** from the Start menu, or open [http://localhost](http://localhost).
3. Follow the setup screen to verify and save your TMDB credential.
4. Use [http://torplay.local](http://torplay.local) from other devices on the household network.

TorPlay starts automatically for the Windows account that installed it. The Start menu provides **Open TorPlay**, **TorPlay Status**, **Start or Restart TorPlay**, and **Stop TorPlay**.

Profiles, history, configuration, and logs are kept under `%LOCALAPPDATA%\TorPlay` and are preserved during upgrades and normal uninstall. See the [complete Windows deployment guide](docs/windows-deployment.md) for installer builds, migration, firewall behavior, data locations, and troubleshooting.

## Development quick start

For native Knaben, YTS, and EZTV discovery without starting Docker services, run
`npm run dev:native`. Configure TMDB as usual. Provider selection and endpoint
overrides are documented in [Torrent providers](docs/torrent-providers.md).

Requirements: Node.js 20.9 or newer. Docker is optional for managed Jackett.

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and complete the setup screen. No environment file or restart is required. Optional Torznab sources can be added in Settings. Set `TORPLAY_MANAGED_JACKETT=true` in `.env.local` only if you want TorPlay to start Jackett and FlareSolverr through Docker.

See [Development](docs/development.md) and [Configuration](docs/configuration.md) for the complete setup.

## Common commands

| Command | Purpose |
| --- | --- |
| `npm install` | Install project dependencies |
| `npm run dev` | Start the development server; add torrent sources in Settings |
| `npm run build` | Create a production Next.js build |
| `npm start` | Start the standard production Next.js server |
| `npm run start:home` | Start the manual Windows home/LAN runtime |
| `npm run firewall:home` | Configure manual-runtime Windows firewall rules |
| `npm run release:windows` | Test, build, and package the Windows installer |
| `npm test` | Run unit and integration tests |
| `npm run lint` | Run ESLint |

## Documentation

- [Documentation index](docs/README.md)
- [Windows deployment](docs/windows-deployment.md)
- [Configuration](docs/configuration.md)
- [Development](docs/development.md)
- [Architecture](docs/architecture.md)
- [Features and API](docs/features-and-api.md)
- [Troubleshooting](docs/troubleshooting.md)
