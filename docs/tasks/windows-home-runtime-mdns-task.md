# TorPlay Windows Production Runtime + Local Network Discovery

Prepare TorPlay to run as a simple always-available home service on a Windows PC.

Follow `AGENTS.md` for project architecture, simplicity, validation, and scope rules.

This task is Windows-only.

Do not build a full installer yet. The next task will handle Windows installation/service registration and polished end-user setup.

## Goal

After this task, TorPlay should have a clean production runtime that can be started with one command/script and exposed to the home network as:

```text
http://torplay.local
```

The runtime should manage the required TorPlay processes and provide clear health/status information.

No developer should need to manually run several terminals or commands.

## 1. Audit first

Before modifying code, inspect and briefly report:

- current `npm run dev` startup flow
- current Next.js production build/start support
- how Jackett and FlareSolverr are currently started/stopped
- current Docker Compose usage
- current TorPlay bind host/port
- current persistent and temporary data paths
- whether production/start scripts already exist
- whether health endpoints already exist
- what is needed for LAN access from another device

Then implement the task. Do not stop after the audit.

## 2. Production runtime

Create a proper production startup path.

Do not use the Next.js development server for normal home usage.

Provide a simple production command, conceptually:

```text
npm run build
npm run start:home
```

or another naming scheme consistent with the project.

`start:home` should:

- start TorPlay in production mode
- bind appropriately for LAN access
- use a configurable internal app port
- default to a sensible internal port such as `3000`

## 3. Runtime supervisor

Add one small Windows-friendly supervisor/launcher responsible for the required local services:

- TorPlay production server
- Jackett
- FlareSolverr
- mDNS/local discovery
- port-80 frontend/reverse proxy if needed

Reuse the current Docker Compose setup for Jackett and FlareSolverr.

Do not remove or redesign Docker in this task.

The supervisor should:

- start required dependencies
- start TorPlay
- detect obvious startup failures
- avoid duplicate TorPlay instances
- terminate child processes cleanly
- produce understandable logs

Keep this small and readable.

## 4. Docker handling

For this task, Docker Desktop may remain a requirement.

Before starting Jackett/FlareSolverr:

- detect whether Docker is installed/available
- detect whether the Docker daemon is running
- show a useful error if Docker cannot be reached

Example:

```text
TorPlay could not start because Docker is not running.
Start Docker Desktop and try again.
```

Use the existing Compose configuration and existing persistent volumes.

Do not silently leave the runtime half-started.

## 5. mDNS and `torplay.local`

Advertise TorPlay on the local network using mDNS so devices on the same home network can use:

```text
http://torplay.local
```

Requirements:

- do not modify router DNS
- do not require a static IP
- use a stable existing Node library where appropriate
- advertise only after TorPlay is ready
- stop the advertisement cleanly on shutdown

The implementation should target a normal private Windows home network.

## 6. Friendly port 80 URL

The desired user-facing URL is:

```text
http://torplay.local
```

not:

```text
http://torplay.local:3000
```

Inspect the cleanest Windows-friendly approach.

Prefer a small reverse proxy or another simple solution if binding TorPlay itself to port 80 would create unnecessary privilege/maintenance problems.

Requirements:

- public LAN port is 80
- TorPlay may remain internally on port 3000
- the supervisor starts the port-80 component
- API routes continue to work
- HTTP Range requests and seeking continue to work
- HLS/FFmpeg playback continues to work
- subtitles continue to work

Avoid introducing a large web-server stack.

## 7. LAN access

TorPlay must work from another device on the same private network.

Expected:

```text
Windows host:
http://localhost
http://torplay.local

Phone/laptop on same Wi-Fi:
http://torplay.local
```

Do not expose TorPlay to the public internet.

This feature is for trusted LAN usage only.

## 8. Windows Firewall

Handle or prepare the Windows Firewall requirement for LAN access.

If clean and safe in this task, add an administrator helper script for creating the required inbound rule.

Otherwise add a clear script that the later installer can execute.

Requirements:

- only open the required TorPlay LAN port(s)
- use Private network scope where practical
- do not disable Windows Firewall
- do not open unrelated ports

## 9. Health/status

Add or reuse lightweight health checks so the supervisor can report:

```text
TorPlay       OK
Jackett       OK
FlareSolverr  OK
mDNS          OK
```

Also print the useful URLs:

```text
Local:
http://localhost

Network:
http://torplay.local
```

Console status is enough for this task.

Do not build a system-tray application yet.

## 10. Startup order

Use a predictable startup sequence:

```text
check environment
↓
check Docker
↓
start Jackett + FlareSolverr
↓
wait for required dependencies
↓
start TorPlay production server
↓
wait for TorPlay health
↓
start port-80 frontend/proxy if separate
↓
advertise torplay.local
↓
report ready
```

Use reasonable timeouts.

If something required fails, stop cleanly and report which component failed.

Do not wait forever.

## 11. Shutdown

Ctrl+C or supervisor shutdown should clean up processes started by the runtime.

Do not delete persistent data.

Preserve:

- profiles/history SQLite DB
- Jackett configuration
- existing persistent service data

Avoid leaving orphan Node/proxy processes after normal shutdown.

## 12. Configuration

Keep defaults usable without manual editing.

Where useful, support variables such as:

```dotenv
TORPLAY_HOST=0.0.0.0
TORPLAY_PORT=3000
TORPLAY_PUBLIC_HOSTNAME=torplay.local
TORPLAY_PUBLIC_PORT=80
```

Existing `.env.local` provider/application settings must continue working.

## 13. Logging

At minimum log:

- supervisor start
- Docker status
- Jackett readiness
- FlareSolverr readiness
- TorPlay readiness
- proxy/frontend readiness if used
- mDNS registration
- final local/network URLs
- shutdown
- meaningful startup failures

Avoid unnecessary debug spam.

## 14. Keep development flow

Existing development behavior must continue to work.

Developers should still be able to use:

```text
npm run dev
```

The home/production runtime is an additional path, not a replacement for development.

## 15. Do not break existing features

Verify the production runtime does not break:

- profiles/history
- Continue Watching
- Search/Discover
- TMDB metadata
- Jackett search
- FlareSolverr
- torrent streaming
- HTTP Range seeking
- HLS/FFmpeg playback
- subtitles
- next-episode autoplay
- season-pack reuse
- SQLite persistence

## 16. Verification

Add focused automated tests for new pure logic where practical.

Run:

```bash
npm test
npm run lint
npm run build
```

Also manually reason through or smoke-test:

1. Docker running -> runtime starts.
2. Docker unavailable -> clear failure.
3. TorPlay responds locally.
4. TorPlay is reachable from LAN.
5. `torplay.local` is advertised.
6. port 80 forwards correctly.
7. Range requests still work through the public endpoint.
8. shutdown cleans up started processes.
9. persistent data survives restart.
10. `npm run dev` still works normally.

Do not make automated tests depend on public torrent peers.

## 17. Completion report

When finished, report:

- files added/modified
- production startup command
- supervisor design
- Docker handling
- internal TorPlay host/port
- public URL
- mDNS implementation/library
- port-80 solution
- firewall handling
- health checks
- startup/shutdown behavior
- new configuration variables
- tests/results
- lint result
- build result
- remaining limitations

## Expected result

Normal home startup should become:

```text
Start TorPlay runtime
↓
Docker checked
↓
Jackett + FlareSolverr started
↓
TorPlay production server started
↓
port-80 frontend ready
↓
torplay.local advertised
↓
READY

Open:
http://torplay.local
```

A phone, laptop, or future Android TV client on the same home network should be able to use the Windows-hosted TorPlay server without knowing its IP address.
