# Windows Deployment

The recommended production deployment is the per-user TorPlay installer. It bundles the production Next.js application and Node.js runtime, starts TorPlay automatically at login, and opens locally at `http://localhost` without requiring npm, a source checkout, or environment-file setup. Household devices use `http://torplay.local` after setup.

## Requirements

- Windows 10 or 11 x64
- A private home network that permits device-to-device multicast traffic
- A TMDB API Read Access Token

Docker Desktop is not required. TorPlay does not install, start, stop, configure, or monitor external provider applications.

## Install

1. Run `TorPlay-Setup-<version>.exe` as the Windows account that should host TorPlay.
2. Approve the administrator prompt that creates the Private-network firewall rules.
3. Choose **Open TorPlay** from the Start menu, or open [http://localhost](http://localhost).
4. Follow the setup screen to verify and save the TMDB credential.
5. Open [http://torplay.local](http://torplay.local) on other household devices.

Optional Torznab sources can be added from Settings.

## Optional Jackett Indexers

TorPlay can use an independently operated **Jackett** instance alongside its built-in providers. Jackett requires its own configured indexers to contribute results and remains outside the TorPlay runtime lifecycle.

If Jackett is available on the TorPlay computer, open its dashboard in your browser:

`http://localhost:9117`

### 1. Add authorized indexers

In Jackett:

1. Click **Add indexer**.
2. Search for each indexer listed below.
3. Click the **+** button to add it.
4. Complete any configuration requested by Jackett.
5. Use **Test** to verify that the indexer is working.

Examples commonly used for the listed media types include:

**Movies**

* YTS
* LimeTorrents
* TorrentDownload
* TorrentDownloads
* Knaben
* The Pirate Bay

**TV Shows**

* EZTV
* LimeTorrents
* TorrentDownload
* Knaben
* KickAssTorrents.ws
* The Pirate Bay

Some indexers are used for both movies and TV shows, so they only need to be added to Jackett once.

### 2. Verify the indexers

The configured indexers should show as working in the Jackett dashboard. If an indexer fails its Jackett test, TorPlay may not be able to retrieve results from it.

Indexer availability can change over time. If one of the recommended indexers is unavailable in your region or stops working, TorPlay can continue using the other configured indexers.

### 3. Configure the Jackett API key

Jackett displays its API key in the Jackett dashboard.

Enter this key under Settings → Services → Jackett. The default Jackett address is `http://localhost:9117`. Use Test connection to verify it.

### 4. TorPlay indexer configuration

TorPlay searches all configured Jackett indexers by default. Advanced owners can set `JACKETT_MOVIE_INDEXERS` and `JACKETT_SHOW_INDEXERS` in the configuration file to restrict each media type to comma-separated Jackett IDs.

### Troubleshooting

If Jackett validates in Settings but movies or TV shows return no torrent sources:

1. Open `http://localhost:9117`.
2. Confirm that your authorized indexers have been added.
3. Run **Test** for the affected indexers.
4. Confirm that `JACKETT_API_KEY` is correct.
5. Confirm that the indexer names configured in `JACKETT_MOVIE_INDEXERS` and `JACKETT_SHOW_INDEXERS` match the indexers you have enabled.

Only use TorPlay and configured indexers to access content you are authorized to access.


## Startup behavior

TorPlay registers a per-user Windows login entry rather than a Windows service:

```text
Windows login
    -> TorPlay tray application
    -> existing TorPlay launcher
    -> start the private Next.js server
    -> expose port 80 to the private LAN
    -> advertise torplay.local with mDNS
```

The tray is a lightweight Windows frontend for the existing supervisor. It does not host another web server or torrent runtime. The supervisor owns the application server, port 80 proxy, mDNS advertisement, runtime lock, and status/control files. Startup waits until that complete runtime reports ready, while restart always completes shutdown before starting a replacement.

## System tray

Right-click the TorPlay notification-area icon to see the current Running/Stopped state and use these commands:

- **Open TorPlay** opens `http://localhost`.
- **Open Logs** opens the current runtime log, or its folder before the first log is created.
- **Start TorPlay** appears while stopped; **Restart TorPlay** appears while running.
- **Stop TorPlay** gracefully stops the existing supervisor.
- **Start with Windows** adds or removes the current user's login entry.
- **Exit** cleanly stops the runtime before closing the tray.

The status is refreshed when the menu opens, so the tray does not continuously poll the runtime or health endpoint. Only one tray process is allowed per signed-in Windows session. Windows logout or shutdown uses the same stop path. The launcher also forwards termination signals to the supervisor, and the application server watches its supervisor so it does not remain orphaned if that supervisor is terminated unexpectedly.

## Start menu

- **Open TorPlay** opens the editable local owner address at `http://localhost`.
- **TorPlay Tray** restores the notification-area frontend after it was closed with Exit.
- **TorPlay Status** reports TorPlay and mDNS state, plus the last failure and important file paths.
- **Start or Restart TorPlay** gracefully stops an existing runtime and launches it again.
- **Stop TorPlay** requests a graceful shutdown and uses the recorded TorPlay process tree only as a fallback.

## Installed files and data

Application files are replaceable:

```text
%LOCALAPPDATA%\Programs\TorPlay
```

Writable state is separate and persistent:

```text
Configuration  %LOCALAPPDATA%\TorPlay\config\torplay.env
Database       %LOCALAPPDATA%\TorPlay\data\torplay.db
Cache          %LOCALAPPDATA%\TorPlay\cache
Runtime state  %LOCALAPPDATA%\TorPlay\runtime
Logs           %LOCALAPPDATA%\TorPlay\logs
```

The runtime log rotates at 5 MiB and retains three backups. Installer and uninstaller logs are copied into the same log directory. External provider applications manage their own configuration and data.

## Firewall and LAN access

Setup creates only these inbound rules for the bundled Node executable:

| Protocol | Port | Profile | Remote scope |
| --- | ---: | --- | --- |
| TCP | 80 | Private | Local subnet |
| UDP | 5353 | Private | Local subnet |

The internal Next.js port remains bound to loopback. The public proxy accepts only loopback and private-address clients. TorPlay does not disable Windows Firewall, configure port forwarding, or use UPnP.

Windows must classify the home network as **Private**. Guest Wi-Fi or access-point isolation can prevent both LAN access and mDNS discovery.

## Configuration changes

Open [http://localhost/settings](http://localhost/settings) to update provider settings. TMDB and optional torrent-source changes activate immediately. Advanced runtime settings can be edited in `%LOCALAPPDATA%\TorPlay\config\torplay.env`; see [Configuration](configuration.md).

## Upgrade and reinstall

Run the newer installer normally. It stops the existing runtime, replaces application/runtime files, retains `%LOCALAPPDATA%\TorPlay`, and starts TorPlay again. The installer never overwrites an existing `torplay.env`.

Older TorPlay versions may have created Jackett or FlareSolverr containers and volumes. Upgrades leave these legacy Docker artifacts untouched but no longer start, configure, or monitor them. Remove them manually in Docker Desktop only if you no longer need their data.

## Uninstall

Uninstall closes the tray, stops the runtime, and removes application/runtime files, login startup registration, Start-menu shortcuts, and TorPlay-created firewall rules.

It preserves `%LOCALAPPDATA%\TorPlay` by default. Delete it manually only if profiles, history, configuration, and logs are no longer wanted. Legacy Docker artifacts from older TorPlay versions remain independently managed and are not changed by uninstall.

## Migrate from the source runtime

1. Stop the old TorPlay runtime.
2. Copy `persistent-data\torplay.db` and any `torplay.db-wal` or `torplay.db-shm` sidecars into `%LOCALAPPDATA%\TorPlay\data`.
3. Copy provider values from `.env.local` into `%LOCALAPPDATA%\TorPlay\config\torplay.env`.
4. Choose **Start or Restart TorPlay**.

## Build the installer

Release builds must run on Windows x64 so SQLite, FFmpeg, and FFprobe native files match the target platform.

### GitHub Actions

The **Windows installer** workflow runs only manually: open GitHub Actions, select **Windows installer**, choose **Run workflow**, and select the branch to package. Pull requests and tags do not start installer builds. When manually running against a tag, its name must match `v<package-version>`.

Before merging a pull request into `develop`, run relevant tests, the full test suite, lint, and a production build locally. GitHub Actions checks are not required for merging. Promotion to `main` also requires explicit release approval and manual testing.

Each successful run retains one workflow artifact for 14 days containing the versioned installer and its SHA-256 file. The workflow verifies the checksum before upload. Download both files and compare the published digest before distributing the installer. This workflow does not create or modify a GitHub Release.

### Local Windows build

Requirements:

- Node.js and npm for the release workstation only
- Inno Setup 7.1.0
- Network access to download the pinned Node.js runtime

```powershell
npm install
npm run release:windows
```

If Inno Setup is installed in a custom location, set `INNO_SETUP_COMPILER` to the full `ISCC.exe` path. The release command runs tests and lint, creates the standalone production build, bundles the supervisor, verifies Node.js 24.21.0 with its pinned SHA-256, validates native runtime files, and writes:

```text
dist\windows\TorPlay-Setup-<version>.exe
dist\windows\TorPlay-Setup-<version>.exe.sha256
```

The release command rejects non-Windows and non-x64 hosts instead of producing an incompatible installer.

## Manual source runtime

For development or owner diagnostics from a source checkout:

```powershell
npm run build
npm run firewall:home
npm run start:home
```

This path requires the development Node/npm installation and is not the normal household deployment. The installer is preferred.

See [Troubleshooting](troubleshooting.md) when startup or LAN discovery fails.
