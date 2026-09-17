# Development

## Prerequisites

- Node.js 20.9 or newer
- npm
- Docker with the `docker compose` command
- Permission to download and view the selected content

TorPlay requires a persistent Node.js process. It is not designed for serverless or multi-instance deployment.

## Setup

```bash
npm install
cp .env.local.example .env.local
npm run dev
```

Add the required TMDB and Jackett credentials to `.env.local`; see [Configuration](configuration.md). Open:

- TorPlay: [http://localhost:3000](http://localhost:3000)
- Jackett: [http://localhost:9117](http://localhost:9117)

Configure at least one authorized Jackett indexer and copy its API key into `.env.local`. Restart `npm run dev` after changing configuration.

## Development runtime

`npm run dev` performs the following work:

1. Starts FlareSolverr and Jackett using the existing `docker-compose.yml`.
2. Waits for both services to become healthy.
3. Configures Jackett to use FlareSolverr at `http://flaresolverr:8191`.
4. Preserves an existing Jackett OMDb key unless `OMDB_API_KEY` is configured.
5. Starts the Next.js development server.

Press Ctrl+C to stop Next.js and the two Compose services. The containers and named volumes are retained; the script never uses `docker compose down -v`.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start Jackett, FlareSolverr, and Next.js development |
| `npm run build` | Create the standard production build |
| `npm start` | Run the standard production build |
| `npm run start:home` | Run the manual Windows LAN supervisor after a build |
| `npm run firewall:home` | Add manual-runtime Windows firewall rules |
| `npm run release:windows` | Create the complete Windows installer on Windows x64 |
| `npm test` | Run Node.js unit and integration tests |
| `npm run lint` | Run ESLint |

## Data during development

| Path | Purpose | Persistence |
| --- | --- | --- |
| `persistent-data/torplay.db` | Profiles, history, progress, writer state | Persistent, gitignored |
| `.data/torrents` | Managed torrent session files | Temporary, gitignored |
| `.data/subtitles` | Subtitle cache | Re-creatable, gitignored |
| OS temporary directory | HLS and subtitle-conversion jobs | Temporary |
| Docker named volumes | Jackett and FlareSolverr configuration | Persistent |

Do not point `TORRENT_DOWNLOAD_PATH` at a directory containing personal files. TorPlay owns and cleans info-hash directories under that path.

## Quality checks

Before completing a change, run:

```bash
npm test
npm run lint
npm run build
```

Tests that open loopback ports or start WebTorrent may require a normal local shell when a restricted sandbox blocks socket binding.

## Contribution boundaries

- Keep browser clients away from Jackett credentials, magnets, torrent metadata downloads, swarm connections, and provider keys.
- Keep torrent streaming server-side and preserve HTTP Range semantics.
- Preserve the separation between `app/`, `components/`, and `lib/` described in [Architecture](architecture.md).
- Keep generated data outside source control.
- Do not add authentication, databases beyond the existing SQLite store, or alternative streaming stacks without an explicit task.
- Do not replace the Jackett/FlareSolverr Compose setup.

The root `AGENTS.md` contains the complete repository-specific implementation rules.
