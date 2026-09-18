# Windows Deployment

The recommended production deployment is the per-user TorPlay installer. It bundles the production Next.js application and Node.js runtime, starts TorPlay automatically at login, and exposes `http://torplay.local` without requiring npm or a source checkout.

## Requirements

- Windows 10 or 11 x64
- Docker Desktop using Linux containers
- A private home network that permits device-to-device multicast traffic
- A TMDB API Read Access Token
- Jackett configured with at least one authorized indexer

Docker Desktop remains external because Jackett and FlareSolverr continue to use the existing Docker Compose setup. TorPlay does not install or replace Docker Desktop.

## Install

1. Install Docker Desktop from its official installer.
2. Open Docker Desktop once and accept its agreement.
3. Run `TorPlay-Setup-<version>.exe` as the Windows account that should host TorPlay.
4. Approve the administrator prompt that creates the Private-network firewall rules.
5. Open `%LOCALAPPDATA%\TorPlay\config\torplay.env` and configure at least:

   ```dotenv
   TMDB_API_TOKEN=your-tmdb-read-access-token
   JACKETT_URL=http://localhost:9117
   JACKETT_API_KEY=your-jackett-api-key
   ```

6. Restart Windows or sign out and back in.
7. Open [http://torplay.local](http://torplay.local).

If Docker Desktop is missing, setup explains the requirement and offers its official download page. After installing Docker later, open it once and then restart Windows or choose **Start or Restart TorPlay**.

## Configure Jackett Indexers

TorPlay uses **Jackett** to search torrent indexers. Jackett may be running correctly while TorPlay still returns no playable sources if no indexers have been configured.

After installing TorPlay and starting Docker, open Jackett in your browser:

`http://localhost:9117`

### 1. Add the required indexers

In Jackett:

1. Click **Add indexer**.
2. Search for each indexer listed below.
3. Click the **+** button to add it.
4. Complete any configuration requested by Jackett.
5. Use **Test** to verify that the indexer is working.

For the default TorPlay configuration, add these indexers:

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

TorPlay needs this key in its configuration:

`JACKETT_API_KEY=your_jackett_api_key`

For the Windows installation, the TorPlay configuration is stored at:

`%LOCALAPPDATA%\TorPlay\config\torplay.env`

The default Jackett address is:

`JACKETT_URL=http://localhost:9117`

### 4. TorPlay indexer configuration

TorPlay's default configuration separates movie and TV indexers:

`JACKETT_MOVIE_INDEXERS=yts,limetorrents,torrentdownload,torrentdownloads,knaben,thepiratebay`

`JACKETT_SHOW_INDEXERS=eztv,limetorrents,torrentdownload,knaben,kickasstorrents-ws,thepiratebay`

The names in these lists correspond to the Jackett indexers TorPlay will search. If you change the configured indexers in Jackett, update these values accordingly.

### Troubleshooting

If Jackett shows as **OK** in TorPlay Status but movies or TV shows return no torrent sources:

1. Open `http://localhost:9117`.
2. Confirm that the required indexers have been added.
3. Run **Test** for the affected indexers.
4. Confirm that `JACKETT_API_KEY` is correct.
5. Confirm that the indexer names configured in `JACKETT_MOVIE_INDEXERS` and `JACKETT_SHOW_INDEXERS` match the indexers you have enabled.

Only use TorPlay and configured indexers to access content you are authorized to access.


## Startup behavior

TorPlay registers a per-user Windows login entry rather than a service because Docker Desktop runs in the interactive user session:

```text
Windows login
    -> TorPlay launcher
    -> start/wait for Docker Desktop
    -> start Jackett and FlareSolverr with Docker Compose
    -> start the private Next.js server
    -> expose port 80 to the private LAN
    -> advertise torplay.local with mDNS
```

Docker readiness uses bounded retries: 5 seconds, 10 seconds, 20 seconds, and then 30-second intervals for at most ten minutes. A timeout is written to the status file and runtime log rather than retried forever.

## Start menu

- **Open TorPlay** opens `http://torplay.local`.
- **TorPlay Status** reports Docker, Jackett, FlareSolverr, TorPlay, and mDNS state, plus the last failure and important file paths.
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

The runtime log rotates at 5 MiB and retains three backups. Installer and uninstaller logs are copied into the same log directory. Jackett and FlareSolverr retain their configuration in Docker named volumes under the stable Compose project name `torplay`.

## Firewall and LAN access

Setup creates only these inbound rules for the bundled Node executable:

| Protocol | Port | Profile | Remote scope |
| --- | ---: | --- | --- |
| TCP | 80 | Private | Local subnet |
| UDP | 5353 | Private | Local subnet |

The internal Next.js port remains bound to loopback. The public proxy accepts only loopback and private-address clients. TorPlay does not disable Windows Firewall, configure port forwarding, or use UPnP.

Windows must classify the home network as **Private**. Guest Wi-Fi or access-point isolation can prevent both LAN access and mDNS discovery.

## Configuration changes

Edit `%LOCALAPPDATA%\TorPlay\config\torplay.env`, save it, and use **Start or Restart TorPlay**. See [Configuration](configuration.md) for every supported owner setting.

## Upgrade and reinstall

Run the newer installer normally. It stops the existing runtime, replaces application/runtime files, retains `%LOCALAPPDATA%\TorPlay`, retains Docker volumes, and starts TorPlay again. The installer never overwrites an existing `torplay.env`.

## Uninstall

Uninstall removes application/runtime files, login startup registration, Start-menu shortcuts, and TorPlay-created firewall rules.

It preserves `%LOCALAPPDATA%\TorPlay` and TorPlay's Docker named volumes by default. Delete them manually only if profiles, history, configuration, logs, and Jackett settings are no longer wanted. Do not remove unrelated Docker volumes.

## Migrate from the source runtime

1. Stop the old TorPlay runtime.
2. Copy `persistent-data\torplay.db` and any `torplay.db-wal` or `torplay.db-shm` sidecars into `%LOCALAPPDATA%\TorPlay\data`.
3. Copy provider values from `.env.local` into `%LOCALAPPDATA%\TorPlay\config\torplay.env`.
4. Choose **Start or Restart TorPlay**.

## Build the installer

Release builds must run on Windows x64 so SQLite, FFmpeg, and FFprobe native files match the target platform.

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
