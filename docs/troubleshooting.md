# Troubleshooting

## Start with status and logs

On an installed Windows host, open **TorPlay Status** from the Start menu. It reports Docker, Jackett, FlareSolverr, TorPlay, and mDNS health and shows the last startup failure.

Runtime logs are stored at:

```text
%LOCALAPPDATA%\TorPlay\logs\torplay.log
```

The log rotates at 5 MiB and retains three backups. Setup and uninstall logs are kept in the same directory.

## Docker is missing

Install Docker Desktop from its official installer. Open it once, accept its agreement, and wait for the Docker engine to become ready. Then restart Windows or choose **Start or Restart TorPlay**.

TorPlay does not include a custom Docker installer.

## Docker is installed but not ready

The installed runtime attempts to start Docker Desktop and waits for up to ten minutes. If it still fails:

1. Open Docker Desktop directly and inspect its status.
2. Confirm it is using Linux containers.
3. Confirm WSL 2 or the selected Docker backend is healthy.
4. Choose **Start or Restart TorPlay** after Docker reports that it is running.

## Jackett or FlareSolverr fails

- Confirm Docker is healthy.
- Open [http://localhost:9117](http://localhost:9117).
- Confirm at least one Jackett indexer is configured and working.
- Open [http://localhost/settings](http://localhost/settings) and confirm the Jackett API key matches the value shown by Jackett.
- Confirm explicitly listed movie/show indexer IDs exist in Jackett.
- Required Jackett settings activate immediately after TorPlay verifies and saves them.

TorPlay configures Jackett's FlareSolverr URL internally as `http://flaresolverr:8191`; port 8191 is intentionally not published to Windows.

## Metadata is unavailable

Open [http://localhost/settings](http://localhost/settings) on the TorPlay computer and check TMDB's connection status. The token must be the TMDB API Read Access Token, not the 32-character v3 API key. Provider credentials can also be maintained in `.env.local` for development or `%LOCALAPPDATA%\TorPlay\config\torplay.env` for an installed runtime.

## Setup keeps reopening

Open [http://localhost/setup](http://localhost/setup) on the TorPlay computer. Setup requires a valid TMDB API Read Access Token rather than TMDB's v3 key. Built-in source search does not need Jackett or Docker. Test optional custom Torznab endpoints and API keys under Settings → Torrent Sources; managed Jackett additionally requires Docker and `TORPLAY_MANAGED_JACKETT=true`.

## Settings are read-only

Provider settings can be changed only from `localhost` on the TorPlay computer. This protects credentials from other household devices. Open [http://localhost/settings](http://localhost/settings), not `http://torplay.local/settings`, to edit them. Values supplied by the host environment are also read-only in the page and must be changed at their source.

If Settings reports that a restart is required after an OMDb change, choose **Start or Restart TorPlay** from the Windows Start menu. Other provider credential changes are used by new requests without a restart.

## `torplay.local` does not open

Check these conditions:

- TorPlay Status reports TorPlay and mDNS as `OK`.
- The Windows network profile is **Private**, not Public.
- The client is on the same home network.
- Guest Wi-Fi, client isolation, or access-point isolation is disabled.
- No other device is already advertising `torplay.local`.
- A VPN or virtual adapter is not confusing mDNS interface selection.

If necessary, set `TORPLAY_MDNS_INTERFACE` to the Windows interface name or local IP, restart TorPlay, and test again.

Ordinary browser hostname navigation does not use the DNS-SD service port. A custom `TORPLAY_PUBLIC_PORT` therefore requires the port in the URL; the installer is designed for port 80.

## Firewall or LAN access fails

The installer creates Private-profile rules for TCP 80 and UDP 5353, scoped to the bundled Node executable and local subnet. Re-run the installer if those rules were declined or removed.

For the manual source runtime, open PowerShell as Administrator and run:

```powershell
npm run firewall:home
```

For a custom manual-runtime public port:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/windows-firewall.ps1 -PublicPort 8080
```

Do not disable Windows Firewall.

## A port is already in use

TorPlay requires internal port 3000 and public port 80 by default. Stop the conflicting application or change the source-runtime configuration. For an installed household deployment, keeping port 80 is recommended so `http://torplay.local` remains simple.

## Sources load slowly or do not start

Torrent availability depends on reachable peers. Jackett's seeder count can be stale. The player reports peers and current transfer speed from the active WebTorrent session.

- Try another verified source.
- Prefer sources with more reachable peers.
- Check that the network permits torrent traffic.
- Magnet-only sources may take up to two minutes to obtain metadata.

TorPlay cannot repair a dead swarm.

## Converted playback fails

Native MP4, M4V, and WebM avoid conversion. Other containers may require CPU-intensive FFmpeg processing.

- Check the runtime log for FFmpeg or FFprobe errors.
- Reinstall dependencies or the Windows application if bundled executables are missing.
- For a source runtime, optionally set absolute `FFMPEG_PATH` and `FFPROBE_PATH` overrides.
- Try a native browser-compatible source when available.

## Profiles or history appear missing

Confirm the runtime is using the expected database:

- Development: `persistent-data/torplay.db`
- Installed Windows: `%LOCALAPPDATA%\TorPlay\data\torplay.db`

When migrating, stop TorPlay before copying the database and include any `torplay.db-wal` and `torplay.db-shm` files. Do not copy an active SQLite database while it is being written.

## Development tests cannot bind a port

Some integration tests create loopback HTTP servers or WebTorrent listeners. An `EPERM` bind failure in a restricted sandbox is an environment limitation; rerun the suite in a normal local shell. `EADDRINUSE` instead means another process already owns the requested port.
