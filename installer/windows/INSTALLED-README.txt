2TorPlay for Windows
===================

Open TorPlay at http://torplay.local after Docker Desktop and TorPlay finish starting.

Configuration:
  Open http://localhost/settings on the TorPlay computer to manage provider keys.
  For manual fallback, edit %LOCALAPPDATA%\TorPlay\config\torplay.env.
  Settings opened through torplay.local are intentionally read-only.

Runtime logs:
  %LOCALAPPDATA%\TorPlay\logs\torplay.log

Persistent profiles and watch history:
  %LOCALAPPDATA%\TorPlay\data\torplay.db

Docker Desktop is required. If it was installed after TorPlay, start Docker Desktop,
accept its agreement, then restart Windows or use Start/Restart TorPlay in the Start menu.

Migration from the source-checkout runtime:
  1. Stop the old TorPlay runtime.
  2. Copy persistent-data\torplay.db and any torplay.db-wal/torplay.db-shm files into
     %LOCALAPPDATA%\TorPlay\data\.
  3. Copy provider values from .env.local into the configuration file above.
  4. Use Start/Restart TorPlay.

Upgrades and uninstall preserve the writable TorPlay data directory and Docker named
volumes. They can be removed manually only after TorPlay is uninstalled if the owner no
longer wants profiles, history, provider configuration, logs, or Jackett settings.
