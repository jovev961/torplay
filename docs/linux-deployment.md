# Linux AppImage: Ubuntu 24.04 x86_64

The first Linux distribution is a desktop-local AppImage. It includes the production application, Node.js, SQLite native module, FFmpeg, and FFprobe. Normal use does not need a source checkout, npm, Docker, Jackett, or FlareSolverr. A regular desktop browser is required. Other devices on the LAN cannot connect to this AppImage, so Google Cast and other receiver-based playback are unavailable in this build.

## Download and run

1. Open the repository's **Actions → Linux AppImage** workflow and download the artifact from a successful run on the intended branch. The workflow is manual and does not create a public GitHub Release.
2. Extract `TorPlay-<version>-x86_64.AppImage` and its `.sha256` file into the same directory.
3. Verify the download with `sha256sum --check TorPlay-<version>-x86_64.AppImage.sha256`.
4. Run `chmod +x TorPlay-<version>-x86_64.AppImage` if needed, then launch it from the file manager or a terminal.
5. The default browser opens TorPlay on `127.0.0.1` at an available port. Add your TMDB API Read Access Token during setup, then configure only the torrent sources you intend to use.

The AppImage starts one TorPlay instance per Linux account. Launching it again reopens that instance in the browser. Closing the browser tab **does not** stop TorPlay: use **Settings → General → Quit TorPlay**, or run the same AppImage with `--stop`. When launched from a terminal, Ctrl+C also stops it.

## Data and updates

TorPlay stores configuration in `$XDG_CONFIG_HOME/torplay/torplay.env`, its database and downloads under `$XDG_DATA_HOME/torplay`, subtitle cache under `$XDG_CACHE_HOME/torplay`, and status/logs under `$XDG_STATE_HOME/torplay`. If the XDG variables are unset, the standard directories under your home directory are used (`.config`, `.local/share`, `.cache`, `.local/state`). Runtime lock and socket files use `$XDG_RUNTIME_DIR/torplay` when available. User data is never stored in the AppImage.

To update, Quit TorPlay and launch the newer verified AppImage. The same per-user data remains available. The AppImage does not add a login-startup entry, install a desktop menu shortcut, or modify firewall rules.

## Troubleshooting

- If the browser does not open, check `$XDG_STATE_HOME/torplay/torplay.log` (or `~/.local/state/torplay/torplay.log`) and launch the AppImage from a terminal to see the localhost URL or startup error. Try that URL in a browser manually.
- `--status` prints the saved runtime status; `--stop` requests a graceful shutdown. These options also work when the browser is unavailable.
- On a system without working FUSE, AppImage supports `--appimage-extract-and-run`, but a normal Ubuntu 24.04 desktop must be tested without manually installing runtime dependencies before distribution. See [AppImage's FUSE guidance](https://docs.appimage.org/user-guide/troubleshooting/fuse.html).
- The AppImage supports Linux x86_64 only. It does not expose `torplay.local` or a LAN port; use the Windows installer or source runtime for current LAN support.
