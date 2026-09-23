# Windows Installation and First Run

The recommended way to run TorPlay is the self-contained, per-user Windows installer. It includes the production application, Node.js runtime, SQLite native module, FFmpeg, FFprobe, tray controls, and runtime supervisor. Normal installation does not require developer tools, a source checkout, Docker Desktop, Jackett, or FlareSolverr.

## Requirements

- Windows 10 or 11 x64
- A private home network for access from other household devices
- A free TMDB account and TMDB API Read Access Token
- Permission to download and view the content you select

## Download TorPlay

1. Open the official [TorPlay Releases page](https://github.com/jovev961/torplay/releases).
2. Open the newest release you want to install. Beta versions are marked **Pre-release**.
3. Download both files:
   - `TorPlay-Setup-<version>.exe`
   - `TorPlay-Setup-<version>.exe.sha256`
4. Keep the two files together until you have verified the installer.

The checksum file lets you confirm that the installer was downloaded intact. In PowerShell, change to the download folder and run:

```powershell
(Get-FileHash -Algorithm SHA256 .\TorPlay-Setup-<version>.exe).Hash
```

Compare the displayed hash with the first value in the `.sha256` file. Do not run the installer if they differ.

TorPlay beta installers may not yet be code-signed, so Windows SmartScreen can show an **Unknown publisher** warning. Continue only when the file came from the official TorPlay Releases page and its checksum matches.

## Install

1. Run `TorPlay-Setup-<version>.exe` as the Windows account that will host TorPlay.
2. Choose the installation location or accept the per-user default. Enable **Create a desktop shortcut** only if you want one.
3. Approve the administrator prompt for the Private-network firewall rules. The application itself remains a per-user installation.
4. Finish installation. TorPlay waits for its packaged runtime to become ready, starts the tray, and opens [http://localhost/setup](http://localhost/setup).

No command prompt, environment file, package manager, or manual service installation is required.

## First-time setup

TMDB supplies TorPlay's movie and TV catalog metadata. It is the only required external API service.

### Get a TMDB API Read Access Token

1. Create or sign in to a [TMDB account](https://www.themoviedb.org/signup).
2. Read TMDB's official [API getting-started guide](https://developer.themoviedb.org/docs/getting-started).
3. Open [TMDB API settings](https://www.themoviedb.org/settings/api) and complete TMDB's API registration if prompted.
4. Copy the long **API Read Access Token** shown in the API settings page. Do not use the shorter v3 API key.
5. Paste the token into TorPlay's setup page and choose **Verify and finish**. TorPlay verifies it before saving.

The credential is stored only on the TorPlay computer. Provider settings can be changed through `localhost`, `torplay.local`, or the displayed private LAN address.

### Add torrent sources

After setup, open **Settings → Torrent Sources** and add a compatible third-party source. TorPlay does not include torrent indexers. You can configure a custom Torznab endpoint, import a compatible Cardigann definition, or add an indexer from a validated external Jackett service. External services are not installed or managed by TorPlay. See [Torrent providers](torrent-providers.md) for details.

### Optional API services

These services enhance specific features but are not required for normal operation:

| Service | Purpose | Official setup |
| --- | --- | --- |
| OMDb | IMDb ratings on catalog cards | [OMDb API key](https://www.omdbapi.com/apikey.aspx) |
| OpenSubtitles | Additional subtitle results | [OpenSubtitles API consumers](https://www.opensubtitles.com/en/consumers) |
| SubDL | Additional subtitle results | [SubDL API panel](https://subdl.com/panel/api) |
| Jackett | External Torznab indexers added individually under Torrent Sources | [Jackett project](https://github.com/Jackett/Jackett) |
| FlareSolverr | Browser challenge handling for Cardigann definitions that require it | [FlareSolverr project](https://github.com/FlareSolverr/FlareSolverr) |

Add optional credentials from [http://torplay.local/settings](http://torplay.local/settings), the displayed LAN address, or `http://localhost/settings` on the TorPlay computer. Torrent and embedded subtitles continue to work without external subtitle keys.

## Open TorPlay

- On the TorPlay computer: [http://localhost](http://localhost)
- On another device connected to the same private household network: [http://torplay.local](http://torplay.local)

TorPlay starts automatically when the installing Windows account signs in. It runs in the background through the notification-area tray icon; no terminal window needs to remain open.

## System-tray controls

Right-click the TorPlay tray icon:

- **Open TorPlay** opens the local application.
- **Open Logs** opens the runtime log or its folder.
- **Start TorPlay** starts a stopped runtime.
- **Restart TorPlay** performs a clean stop followed by a verified start.
- **Retry TorPlay** appears after a persistent runtime error and performs a clean full restart.
- **Stop TorPlay** cleanly stops the background runtime while leaving the tray available.
- **Start with Windows** enables or disables automatic startup for the current account.
- **Exit** cleanly stops TorPlay and closes the tray.

The tray reports **Starting**, **Running**, **Recovering**, **Stopped**, or **Error**. The Start menu contains one **TorPlay** launcher. It starts a stopped runtime and waits until it is ready before opening the browser; when TorPlay is already running, it simply opens the browser. Start, restart, stop, status, and log controls remain in the tray menu.

## Logs and basic troubleshooting

The main runtime log is:

```text
%LOCALAPPDATA%\TorPlay\logs\torplay.log
```

Installer and uninstaller logs are copied into the same directory. The runtime log rotates at 5 MiB and retains three backups.

Start with these checks:

- If the tray shows **Error**, open Logs, correct the reported problem, and choose **Retry TorPlay**.
- If setup reappears, confirm you entered the TMDB API Read Access Token rather than the shorter v3 key.
- If `torplay.local` does not open, confirm the Windows network is **Private** and that guest Wi-Fi/client isolation is disabled.
- If the firewall prompt was declined, rerun the installer and approve the Private-network rules.
- If a torrent has no reachable peers, try another authorized source; TorPlay cannot repair a dead swarm.

See [Troubleshooting](troubleshooting.md) for provider, LAN, port, playback, profile, and source-runtime diagnostics.

## Data locations

Application files are replaceable:

```text
%LOCALAPPDATA%\Programs\TorPlay
```

User data is separate:

```text
Configuration  %LOCALAPPDATA%\TorPlay\config
Profiles/data  %LOCALAPPDATA%\TorPlay\data
Cache          %LOCALAPPDATA%\TorPlay\cache
Runtime state  %LOCALAPPDATA%\TorPlay\runtime
Logs           %LOCALAPPDATA%\TorPlay\logs
```

TorPlay preserves the user-data directory during normal upgrades and uninstall.

## Update or reinstall

1. Download the newer installer and checksum from [TorPlay Releases](https://github.com/jovev961/torplay/releases).
2. Verify the checksum.
3. Run the newer installer normally.

Setup stops the existing tray and runtime, replaces application files, preserves `%LOCALAPPDATA%\TorPlay`, restarts TorPlay, and opens the application. Existing `torplay.env` settings are not overwritten.

## Uninstall

Open **Windows Settings → Apps → Installed apps**, find **TorPlay**, and choose **Uninstall**.

Uninstall closes the tray, stops the runtime, removes the application, login-startup entry, Start-menu shortcuts, and TorPlay-created firewall rules. Profiles, history, configuration, cache, and logs remain under `%LOCALAPPDATA%\TorPlay` so a later reinstall can reuse them. Delete that folder manually only when you intentionally want to remove all TorPlay user data.

## Existing source-runtime data

To migrate an existing source installation:

1. Stop both TorPlay runtimes.
2. Copy `persistent-data\torplay.db` and any `torplay.db-wal` or `torplay.db-shm` files into `%LOCALAPPDATA%\TorPlay\data`.
3. Copy any provider values you still need from `.env.local` into `%LOCALAPPDATA%\TorPlay\config\torplay.env`.
4. Start TorPlay from the tray or Start menu.

## Developer and release builds

Building from source is not part of normal installation. Contributors and release maintainers should use [Development](development.md), which contains Node.js prerequisites, source commands, quality checks, and Windows installer build instructions.
