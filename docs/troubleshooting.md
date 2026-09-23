# Troubleshooting

## Start with status and logs

On an installed Windows host, right-click the TorPlay system-tray icon for current runtime status and quick access to logs or start/stop controls. **TorPlay Status** in the Start menu provides the detailed application, LAN proxy, and mDNS report plus the last runtime failure.

Runtime logs are stored at:

```text
%LOCALAPPDATA%\TorPlay\logs\torplay.log
```

The log rotates at 5 MiB and retains three backups. Setup and uninstall logs are kept in the same directory.

TorPlay automatically retries an application, LAN proxy, or mDNS component after two consecutive health failures. If the same component exceeds three recovery attempts within 60 seconds, the tray shows **Status: Error** and the log records the failing component and each attempt. Choose **Retry TorPlay** to perform a clean full restart after correcting the reported problem.

## A Jackett source fails

- Confirm your independently operated Jackett instance is running.
- Open [http://localhost:9117](http://localhost:9117).
- Confirm at least one Jackett indexer is configured and working.
- Open [http://torplay.local/settings](http://torplay.local/settings) or Settings through the displayed LAN address. Test Jackett under **Services**, then check the individual source under **Torrent Sources**.
- If this source was converted from legacy Jackett settings, confirm the named movie/show indexer IDs still exist in Jackett.
- Jackett source choices activate immediately after TorPlay verifies and saves them.

## A Cardigann source needs FlareSolverr

Run FlareSolverr independently on the TorPlay computer or a private LAN host, then configure and test its base URL under **Settings → Services**. Only Cardigann definitions marked `info_flaresolverr` send compatible search-page requests through it; torrent downloads stay direct. Check its service status, then use **Test** on the added source under **Torrent Sources**. If FlareSolverr is missing or unreachable, marked definitions cannot search successfully, but other sources continue to work. An **Add Anyway** source is saved as unverified after a connection failure; it is not proof the indexer works.

## Metadata is unavailable

Open [http://torplay.local/settings](http://torplay.local/settings), Settings through the displayed LAN address, or [http://localhost/settings](http://localhost/settings) on the TorPlay computer and check TMDB's connection status. The token must be the TMDB API Read Access Token, not the 32-character v3 API key. Provider credentials can also be maintained in `.env.local` for development or `%LOCALAPPDATA%\TorPlay\config\torplay.env` for an installed runtime.

## Setup keeps reopening

Open [http://torplay.local/setup](http://torplay.local/setup), the displayed private LAN address, or [http://localhost/setup](http://localhost/setup) on the TorPlay computer. Setup requires a valid TMDB API Read Access Token rather than TMDB's v3 key. Torrent sources are optional and do not control setup readiness. Once setup succeeds, add or test sources under **Settings → Torrent Sources**.

## Settings cannot be changed

Provider settings can be changed from [http://torplay.local/settings](http://torplay.local/settings), the displayed private LAN address, or [http://localhost/settings](http://localhost/settings) on the TorPlay computer. Requests from outside the private local network and values supplied by the host environment remain read-only.

Provider credential changes are used by new requests without a restart.

## A torrent source is unavailable

Distinguish a failed optional service connection from an indexer search failure. Test Jackett or FlareSolverr under **Services** when applicable, then test a Cardigann source or use **Refresh availability** under **Torrent Sources**. A Cardigann definition can be compatible but unverified; check its own login/settings and response before assuming FlareSolverr is the cause. Disabled sources are not searched.

## `torplay.local` does not open

Check these conditions:

- TorPlay Status reports TorPlay, LAN proxy, and mDNS as `OK`.
- The Windows network profile is **Private**, not Public.
- The client is on the same home network.
- Guest Wi-Fi, client isolation, or access-point isolation is disabled.
- No other device is already advertising `torplay.local`.
- A VPN or virtual adapter is not confusing mDNS interface selection.

If necessary, set `TORPLAY_MDNS_INTERFACE` to the Windows interface name or local IP, restart TorPlay, and test again.

Ordinary browser hostname navigation does not use the DNS-SD service port. A custom `TORPLAY_PUBLIC_PORT` therefore requires the port in the URL; the installer is designed for port 80.

If a TV or mobile device cannot resolve `torplay.local`, open **Settings → General → Network Access** on the TorPlay computer and use the displayed LAN IPv4 URL or scan its QR code. The address is detected dynamically and may change after switching Wi-Fi, Ethernet, or DHCP networks.

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
