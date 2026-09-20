TorPlay for Windows
===================

TorPlay opens http://localhost/setup after installation finishes starting.
Get the required TMDB API Read Access Token from:
  https://www.themoviedb.org/settings/api
The first launch verifies and saves it without requiring an environment file.
Household devices can use http://torplay.local after setup is complete.

System tray:
  Right-click the TorPlay notification-area icon to open TorPlay or its logs,
  start/restart/stop the runtime, and control whether the tray starts at login.
  Persistent component failures show Error and can be retried with a clean restart.
  Exit cleanly stops the background runtime before closing the tray.

Configuration:
  Open http://localhost/settings on the TorPlay computer to manage provider keys.
  For manual fallback, edit %LOCALAPPDATA%\TorPlay\config\torplay.env.
  Settings opened through torplay.local are intentionally read-only.

Runtime logs:
  %LOCALAPPDATA%\TorPlay\logs\torplay.log

Persistent profiles and watch history:
  %LOCALAPPDATA%\TorPlay\data\torplay.db

Torrent sources are opt-in. Add preconfigured or custom indexers in Settings.
An independently operated Jackett instance can be connected through Settings.

Migration from the source-checkout runtime:
  1. Stop the old TorPlay runtime.
  2. Copy persistent-data\torplay.db and any torplay.db-wal/torplay.db-shm files into
     %LOCALAPPDATA%\TorPlay\data\.
  3. Copy provider values from .env.local into the configuration file above.
  4. Use Start/Restart TorPlay.

Upgrades and uninstall preserve the writable TorPlay data directory. It can be removed
manually only after TorPlay is uninstalled if the owner no longer wants profiles,
history, provider configuration, or logs.
