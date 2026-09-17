# TorPlay Windows Installer + Auto-Start

Package the existing TorPlay home runtime into a simple Windows installation experience.

Follow `AGENTS.md`.

Assume the previous Windows home-runtime task is already implemented and provides:

- production TorPlay startup
- supervisor/launcher
- Jackett + FlareSolverr startup through the existing Docker setup
- `torplay.local`
- port-80 access
- health checks
- clean shutdown

Do not redesign those systems unless required for packaging.

## Goal

A non-technical user should be able to:

```text
Download TorPlay installer
↓
Install
↓
Restart / sign in
↓
TorPlay starts automatically
↓
Open http://torplay.local
```

No terminal, npm command, Docker Compose command, or manual IP address should normally be required.

---

## 1. Audit first

Before modifying code, inspect and briefly report:

- the runtime/start command created by the previous task
- runtime dependencies
- whether Node must still be installed separately
- Docker Desktop dependency/startup behavior
- required environment/config files
- persistent-data paths
- required Windows Firewall rules
- whether administrator permissions are required
- the cleanest Windows packaging approach for this project

Then implement the task.

Do not stop after the audit.

---

## 2. Windows installer

Create a Windows installer/package for TorPlay.

Use a mature Windows installer technology appropriate for the existing project.

Keep installation simple.

The installer should install the TorPlay runtime into an appropriate application directory.

Do not require the user to manually clone the repository or run:

```text
npm install
npm run build
npm run start:home
```

The release/install process should use an already-built production application where practical.

Do not package source-only development files unless required at runtime.

---

## 3. Runtime dependencies

The installed system should not require a developer Node.js setup.

If the production runtime still requires Node:

- bundle or install the required Node runtime as part of TorPlay
- do not depend on a globally installed developer Node/npm environment

The user should not need npm after installation.

Keep provider/API configuration compatible with the existing TorPlay configuration.

---

## 4. Docker Desktop dependency

For this version, Docker Desktop may remain required for Jackett and FlareSolverr.

The installer/runtime should handle this clearly.

If Docker Desktop is missing:

- detect it
- explain that TorPlay requires Docker Desktop
- provide a clear next action

Do not silently fail.

If practical and maintainable, the installer may guide the user toward Docker installation, but do not build a fragile custom Docker installer.

If Docker Desktop exists but is not running, the TorPlay startup path should retain the clear handling from the previous task.

---

## 5. Auto-start

TorPlay should start automatically when the Windows host becomes usable.

Choose the cleanest approach for the current runtime.

Preferred behavior:

```text
Windows starts
↓
Docker becomes available
↓
TorPlay supervisor starts
↓
TorPlay waits for dependencies
↓
http://torplay.local becomes available
```

Use either:

- a Windows Service, if it works cleanly with the required runtime/Docker behavior

or

- a login/startup mechanism if Docker Desktop makes a service unsuitable

Do not force a Windows Service if it creates unreliable Docker Desktop interaction.

Document the final choice and why.

The normal user should not need to manually launch TorPlay after every restart.

---

## 6. Startup resilience

Auto-start must tolerate Docker taking time to become ready.

Do not fail permanently just because Docker Desktop is still starting.

Use bounded retries/backoff.

Example:

```text
TorPlay starts
↓
Docker not ready
↓
wait/retry
↓
Docker ready
↓
start Jackett + FlareSolverr
↓
start TorPlay
```

Do not retry forever without useful logging.

---

## 7. Windows Firewall

The installer should configure the minimum required Windows Firewall access for TorPlay on the local network.

Requirements:

- only necessary inbound ports
- Private network scope where practical
- do not disable Windows Firewall
- do not broadly expose unrelated services
- remove TorPlay-created firewall rules during uninstall where appropriate

The expected LAN entrypoint remains:

```text
http://torplay.local
```

---

## 8. Persistent data

Upgrades and reinstalls must not casually delete user data.

Preserve:

- `persistent-data/torplay.db`
- profiles
- watch history
- Continue Watching progress
- required Jackett configuration/volumes
- other intentional persistent TorPlay settings

Temporary torrent/cache data may remain disposable according to the existing runtime design.

Use an appropriate Windows application-data location if that is cleaner than storing writable persistent data beside application binaries.

If paths change from development defaults, keep them configurable and document the migration.

---

## 9. Configuration

The installed app should have a predictable writable configuration location.

Do not require parents to edit `.env.local` manually for ordinary use if this can be avoided.

At minimum preserve support for the existing configuration.

If provider keys still require manual configuration, provide a clearly documented configuration file/location for this task.

Do not build a large Settings UI unless one already exists or it is trivial to expose.

A later task can improve first-run configuration if needed.

---

## 10. Start-menu shortcuts

Add simple Windows shortcuts where appropriate:

```text
TorPlay
- Open TorPlay
- TorPlay Status
- Start/Restart TorPlay
- Stop TorPlay
```

Do not expose developer commands.

`Open TorPlay` should open:

```text
http://torplay.local
```

The user should not need to know the internal port.

---

## 11. Status / diagnostics

Provide a simple support/diagnostic entrypoint for the owner of the PC.

It may reuse the previous supervisor status output.

It should make it easy to see:

```text
Docker         OK
Jackett        OK
FlareSolverr   OK
TorPlay        OK
mDNS           OK

Open:
http://torplay.local
```

Also show useful failure information when startup did not succeed.

Do not build a large tray application unless the chosen installer/runtime architecture naturally needs one.

---

## 12. Upgrade behavior

Structure the installer so future TorPlay versions can be installed without destroying persistent data.

An upgrade should replace application/runtime files while keeping user data.

Document any files/directories intentionally retained.

Do not require uninstalling and manually copying the database before every upgrade.

---

## 13. Uninstall behavior

Uninstall should remove:

- TorPlay application/runtime files
- auto-start/service registration
- TorPlay-created shortcuts
- TorPlay-created firewall rules

Do not silently delete personal watch-history/profile data unless the installer framework provides an explicit user choice.

Prefer preserving user data by default or clearly asking whether it should also be removed.

Do not delete unrelated Docker resources.

---

## 14. Logs

Use a stable writable Windows location for runtime/install logs.

The user/maintainer should be able to find logs without searching through the source tree.

At minimum retain useful startup failure information.

Avoid unbounded log growth.

---

## 15. Release build

Add a reproducible release command/script.

Conceptually:

```text
npm run release:windows
```

It should:

```text
run checks
↓
build production TorPlay
↓
prepare runtime files
↓
create Windows installer
```

Use the project's existing build flow where possible.

Do not make the release process depend on manually copying arbitrary files.

---

## 16. Expected parent experience

After installation and configuration:

```text
PC starts
↓
Docker Desktop starts
↓
TorPlay starts automatically
↓
parent opens browser
↓
http://torplay.local
↓
Who's watching?
```

No:

- PowerShell
- Command Prompt
- npm
- Docker Compose commands
- IP address lookup
- source checkout
- manual TorPlay start

---

## 17. Existing behavior must remain intact

Do not break:

- development with `npm run dev`
- Windows home runtime from the previous task
- `torplay.local`
- profiles/history
- SQLite persistence
- Continue Watching
- Search/Discover
- Jackett/FlareSolverr
- torrent streaming/seeking
- subtitles
- autoplay
- season-pack reuse

---

## 18. Verification

Run the existing project checks:

```bash
npm test
npm run lint
npm run build
```

Also verify or reason through:

1. clean Windows installation
2. TorPlay can start from installed files
3. no global npm/Node developer setup is required
4. restart/sign-in triggers TorPlay automatically
5. delayed Docker startup is handled
6. `http://torplay.local` works after startup
7. firewall rule is correct
8. profiles/history survive restart
9. upgrade preserves persistent data
10. uninstall removes TorPlay startup/firewall integration
11. development workflow still works

Where Windows-specific behavior cannot be tested in the current environment, state exactly what remains to be verified on a real Windows machine.

---

## 19. Completion report

When finished, report:

- installer technology chosen
- files added/modified
- install location
- persistent-data location
- bundled runtime dependencies
- Docker Desktop handling
- auto-start mechanism
- retry behavior
- firewall rules
- Start-menu shortcuts
- diagnostics/log location
- upgrade behavior
- uninstall behavior
- release command
- tests/results
- lint/build results
- remaining Windows-only manual verification

## Expected result

The final target is:

```text
Install TorPlay once
↓
Windows starts normally
↓
TorPlay becomes available automatically
↓
Open http://torplay.local
```

The normal household user should not need to know that TorPlay is a Next.js/Node/Docker application.
