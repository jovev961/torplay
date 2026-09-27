# Linux installation: Ubuntu, Debian, and Fedora x86_64

The Linux `.deb`, `.rpm`, and AppImage packages include the production application, Node.js, SQLite native module, FFmpeg, and FFprobe. Normal use does not need a source checkout, npm, Docker, Jackett, or FlareSolverr. A regular desktop browser is required. TorPlay keeps Next.js on loopback and exposes it to private-network clients through its filtered LAN proxy.

## Download and verify

Open the repository's **Actions → Linux packages** workflow, start it manually on the intended branch, then download the artifact from the successful run. Keep the selected package and its `.sha256` file together and verify it with `sha256sum --check <filename>.sha256`. The workflow does not create a public GitHub Release.

## Native installation

On Ubuntu, Debian, Linux Mint, or Pop!_OS:

```bash
sudo apt install ./TorPlay-<version>-amd64.deb
```

On Fedora or another compatible RPM-based distribution:

```bash
sudo dnf install ./TorPlay-<version>-x86_64.rpm
```

Open TorPlay from the desktop application menu or run `torplay`. Enable optional per-user login startup with `torplay-autostart enable`; inspect it with `torplay-autostart status`, and remove it with `torplay-autostart disable`.

Upgrade by installing the newer package through the same package manager. Uninstall with `sudo apt remove torplay` or `sudo dnf remove torplay`. Package removal deletes installed application files but preserves the user's XDG configuration, profiles, database, downloads, cache, and logs.

## Portable AppImage

Run `chmod +x TorPlay-<version>-x86_64.AppImage` if needed, then launch it from the file manager or a terminal. The AppImage does not install desktop-menu or login-startup entries.

On first launch, every format requests administrator authorization to enable standard HTTP port 80. Accept to use `http://torplay.local` without a port. If PolicyKit is missing, TorPlay can offer to install it in a terminal with the distribution package manager; the user still enters the administrator password. Declining or failed setup continues on `http://torplay.local:3000`. The default browser opens the corresponding local `127.0.0.1` address. The LAN IPv4 alternative is shown under **Settings → General → Network Access**. Add your TMDB API Read Access Token during setup, then configure only the torrent sources you intend to use.

TorPlay starts one instance per Linux account. Launching it again reopens that instance in the browser. Closing the browser tab **does not** stop TorPlay: use **Settings → General → Quit TorPlay**, run `torplay --stop` after native installation, or run the same AppImage with `--stop`. When launched from a terminal, Ctrl+C also stops it.

## Data and updates

TorPlay stores configuration in `$XDG_CONFIG_HOME/torplay/torplay.env`, its database and downloads under `$XDG_DATA_HOME/torplay`, subtitle cache under `$XDG_CACHE_HOME/torplay`, and status/logs under `$XDG_STATE_HOME/torplay`. If the XDG variables are unset, the standard directories under your home directory are used (`.config`, `.local/share`, `.cache`, `.local/state`). Runtime lock and socket files use `$XDG_RUNTIME_DIR/torplay` when available. User data is never stored inside the installed application or portable AppImage.

The default LAN hostname is `torplay.local` and TorPlay prefers port `80`. Authorization installs `/etc/sysctl.d/99-torplay-ports.conf` and applies `net.ipv4.ip_unprivileged_port_start=80`; TorPlay itself and its Next.js process continue running as the desktop user. The fallback public port is `3000`. The hostname and preferred port can be changed with `TORPLAY_PUBLIC_HOSTNAME` and `TORPLAY_PUBLIC_PORT` in `torplay.env`; `TORPLAY_MDNS_INTERFACE` can select a physical interface by name or local address when a VPN or virtual adapter confuses automatic selection. A nonstandard port must be included in the browser URL.

If the requested `.local` hostname is still owned on the network, TorPlay uses the conflict-free hostname selected by mDNS and reports that address under **Settings → General → Network Access**. A second launch on the same account still detects and reopens the genuinely running TorPlay instance instead of starting another one.

To update a portable copy, Quit TorPlay and launch the newer verified AppImage. The same per-user data remains available. None of the Linux packages modify firewall rules.

## Troubleshooting

- If the browser does not open, check `$XDG_STATE_HOME/torplay/torplay.log` (or `~/.local/state/torplay/torplay.log`) and launch the AppImage from a terminal to see the localhost URL or startup error. Try that URL in a browser manually.
- If another device cannot open `http://torplay.local`, check the runtime status to see whether TorPlay fell back to port 3000, then try the displayed LAN IPv4 URL. Confirm both devices are on the same private network, client isolation is disabled, and any enabled firewall permits the selected TCP port and mDNS UDP 5353 only on that private network.
- `--status` prints the saved runtime status; `--stop` requests a graceful shutdown. These options also work when the browser is unavailable.
- On a system without working FUSE, AppImage supports `--appimage-extract-and-run`, but a normal Ubuntu 24.04 desktop must be tested without manually installing runtime dependencies before distribution. See [AppImage's FUSE guidance](https://docs.appimage.org/user-guide/troubleshooting/fuse.html).
- The provided Linux packages support x86_64 only.
