# TorPlay

TorPlay is a self-hosted web app for discovering and streaming public-domain, Creative Commons, or otherwise authorized torrent video. Search, torrent traffic, media conversion, provider credentials, profiles, and watch history remain on the TorPlay computer; browsers connect only to the web app.

TorPlay includes movie and TV discovery, Jackett-powered source search, server-side WebTorrent streaming, profiles and Continue Watching, subtitles, autoplay, native HTTP Range playback, and FFmpeg-backed playback for additional video formats.

> Use TorPlay only with content you are legally permitted to download and view.

## Deploy on Windows

The recommended household deployment is the TorPlay Windows installer.

Requirements:

- Windows 10 or 11 x64
- Docker Desktop
- A TMDB API Read Access Token
- At least one configured Jackett indexer and its API key

Installation:

1. Install and open Docker Desktop once, accepting its agreement.
2. Run `TorPlay-Setup-<version>.exe`.
3. Choose **Open TorPlay** from the Start menu, or open [http://localhost](http://localhost).
4. Follow the setup screen to verify and save the TMDB and Jackett credentials.
5. Use [http://torplay.local](http://torplay.local) from other devices on the household network.

TorPlay starts automatically for the Windows account that installed it. The Start menu provides **Open TorPlay**, **TorPlay Status**, **Start or Restart TorPlay**, and **Stop TorPlay**.

Profiles, history, configuration, and logs are kept under `%LOCALAPPDATA%\TorPlay` and are preserved during upgrades and normal uninstall. See the [complete Windows deployment guide](docs/windows-deployment.md) for installer builds, migration, firewall behavior, data locations, and troubleshooting.

## Development quick start

Requirements: Node.js 20.9 or newer and Docker with the `docker compose` command.

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and complete the setup screen. No environment file or restart is required. You can still use `.env.local` for advanced or externally managed configuration. `npm run dev` starts Jackett and FlareSolverr before Next.js.

See [Development](docs/development.md) and [Configuration](docs/configuration.md) for the complete setup.

## Common commands

| Command | Purpose |
| --- | --- |
| `npm install` | Install project dependencies |
| `npm run dev` | Start Docker services and the development server |
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
