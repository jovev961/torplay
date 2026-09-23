# TorPlay

TorPlay is a self-hosted web app for discovering and streaming public-domain, Creative Commons, or otherwise authorized torrent video. Search, torrent traffic, media conversion, provider credentials, profiles, and watch history remain on the TorPlay computer; browsers connect only to the web app.

TorPlay includes movie and TV discovery, optional TorPlay Tested Sources, community Cardigann and custom Torznab sources, server-side WebTorrent streaming, profiles and Continue Watching, subtitles, autoplay, Google Cast and AirPlay controls, native HTTP Range playback, and FFmpeg-backed playback for additional video formats.

> Use TorPlay only with content you are legally permitted to download and view.

## Install on Windows

The self-contained Windows installer does not require Node.js, npm, Docker, Jackett, FlareSolverr, or a source checkout.

1. Open [TorPlay Releases](https://github.com/jovev961/torplay/releases) and download `TorPlay-Setup-<version>.exe` plus its `.sha256` file.
2. Run the installer on Windows 10 or 11 x64 and approve the Private-network firewall prompt.
3. Wait while TorPlay starts. The installer opens the first-time setup page automatically.
4. Paste a TMDB **API Read Access Token** from [TMDB API settings](https://www.themoviedb.org/settings/api), test it, and finish setup.
5. When you are ready to search authorized content, open **Settings → Torrent Sources** and choose a TorPlay Tested Source, explore community Cardigann indexers, or add a custom Torznab source. None are added automatically.

TorPlay then opens at [http://localhost](http://localhost). Other devices on the same private household network can use [http://torplay.local](http://torplay.local). The system-tray icon provides Open, Logs, Start/Restart, Stop, login-startup, Retry, and Exit controls.

Profiles, history, configuration, and logs are kept under `%LOCALAPPDATA%\TorPlay` and are preserved during upgrades and normal uninstall. See the [complete Windows installation and first-run guide](docs/windows-deployment.md) for checksum verification, API setup, tray controls, troubleshooting, updates, and uninstalling.

## Run on Ubuntu 24.04 x86_64

The Linux AppImage bundles TorPlay's runtime and media tools. Download the AppImage and checksum from the manually triggered **Linux AppImage** workflow artifact, verify the checksum, make the AppImage executable, and launch it. TorPlay opens in your default browser on this computer only. See the [Linux AppImage guide](docs/linux-deployment.md) for exact commands, first-run setup, Quit, updates, and troubleshooting.

## Developer/source setup

Source development is separate from normal installation and requires Node.js and npm. See [Development](docs/development.md) for prerequisites, commands, local data, quality checks, and standalone release builds.

## Documentation

- [Documentation index](docs/README.md)
- [Windows deployment](docs/windows-deployment.md)
- [Linux AppImage](docs/linux-deployment.md)
- [Configuration](docs/configuration.md)
- [Development](docs/development.md)
- [Architecture](docs/architecture.md)
- [Features and API](docs/features-and-api.md)
- [Troubleshooting](docs/troubleshooting.md)
