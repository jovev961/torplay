2TorPlay for Windows
===================

Open TorPlay at http://localhost after TorPlay finishes starting.
The first launch guides you through TMDB setup without editing files.
Household devices can use http://torplay.local after setup is complete.

Configuration:
  Open http://localhost/settings on the TorPlay computer to manage provider keys.
  For manual fallback, edit %LOCALAPPDATA%\TorPlay\config\torplay.env.
  Settings opened through torplay.local are intentionally read-only.

Runtime logs:
  %LOCALAPPDATA%\TorPlay\logs\torplay.log

Persistent profiles and watch history:
  %LOCALAPPDATA%\TorPlay\data\torplay.db

Torrent sources are opt-in. Add preconfigured or custom indexers in Settings.
For managed Jackett only, install Docker Desktop and set TORPLAY_MANAGED_JACKETT=true
in torplay.env, then use Start or Restart TorPlay. Existing Jackett credentials are retained.

Migration from the source-checkout runtime:
  1. Stop the old TorPlay runtime.
  2. Copy persistent-data\torplay.db and any torplay.db-wal/torplay.db-shm files into
     %LOCALAPPDATA%\TorPlay\data\.
  3. Copy provider values from .env.local into the configuration file above.
  4. Use Start/Restart TorPlay.

Upgrades and uninstall preserve the writable TorPlay data directory and Docker named
volumes. They can be removed manually only after TorPlay is uninstalled if the owner no
longer wants profiles, history, provider configuration, logs, or Jackett settings.
