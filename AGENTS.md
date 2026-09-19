# AGENTS.md

## Project
Build a simple web app for discovering and streaming public-domain, Creative Commons, or otherwise authorized torrent video content.

## Stack
- Next.js App Router
- JavaScript only, no TypeScript
- Server-side torrent handling
- HTML5 video player
- Prefer native browser-compatible MP4/WebM initially
- Jackett/Prowlarr Torznab API may be used for torrent search

## Architecture
Keep responsibilities separated:
- `app/` - pages and API routes
- `components/` - reusable UI
- `lib/torrent/` - torrent client, lifecycle, file selection
- `lib/search/` - torrent search integration
- `lib/video/` - range requests and video utilities

The browser must never connect directly to the torrent swarm.
Torrent downloads and streaming happen server-side.

## Rules
- Keep the implementation simple and readable.
- Do not overengineer or introduce unnecessary abstractions.
- Use small reusable functions/modules.
- Prefer existing stable libraries over custom implementations.
- Never expose API keys to the client.
- Support HTTP Range requests correctly for video seeking.
- Validate magnet links, torrent files, file IDs, and user input.
- Clean up torrent sessions/resources when no longer needed.
- Do not add FFmpeg/HLS until basic native video streaming works.

## Development
Implement features incrementally and keep the app runnable after each step.
Fix lint/build/runtime errors before continuing.
Do not rewrite unrelated files.

## GitHub Issue Tasks

When asked to implement a GitHub issue:

1. Read the complete issue before modifying code.
2. Treat the issue description and acceptance criteria as the task specification.
3. Inspect the relevant existing implementation first.
4. For bugs, reproduce or establish the root cause before implementing a fix.
5. Keep changes scoped to the issue. Avoid unrelated refactoring.
6. Add or update relevant tests.
7. Run tests and lint before completing the task.
8. Report the root cause/approach, changed files, tests, and verification results.

## Git Workflow

Use `main` as the stable/release branch and `develop` as the integration/testing branch.

1. Fetch origin and start new work from a clean, current `origin/develop` on a scoped `feat/...`, `fix/...`, or `refactor/...` branch.
2. Implement and verify the change with relevant tests, the full suite, lint, and a production build.
3. Push the completed branch and open a pull request into `develop`. Required CI must pass before merging.
4. Testing fixes branch from current `develop` and return through a separate pull request and commit; do not rewrite the original feature commit.
5. Delete completed feature/fix/refactor branches only after their pull requests are successfully merged.
6. Promote `develop` to `main` only through a pull request after explicit user approval and final verification. Never promote it automatically.
7. Never directly push implementation changes to protected `main` or `develop`, force-push, rewrite published history, discard unrelated work, or bypass failing checks.
8. Only bump the application version when preparing a public release/build. During beta, increment only the beta number unless instructed otherwise.

After completion, report the branch, pull request, commit, verification results, and merge status.
