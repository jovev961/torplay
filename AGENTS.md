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

1. Fetch origin. Ensure `develop` is clean and synchronized with `origin/develop`, then start each issue/change from latest `origin/develop`. Preserve unrelated work before switching branches. Do not make implementation commits directly on `main` or `develop`.
2. Create a scoped branch:
   - `feat/issue-<number>-<description>` for features.
   - `fix/issue-<number>-<description>` for fixes.
   - `refactor/issue-<number>-<description>` for refactoring.
3. Implement the change, add/update tests, and run relevant tests, the full test suite, lint, and a production build.
4. Commit and push the working branch.
5. Refresh remote state and incorporate any new changes safely. Merge the completed branch into `develop` only when verification passes, verify the integrated tree, then push `develop`.
6. Delete the completed local and remote working branch only after verifying its commit is contained in remote `develop`. Return to clean, synchronized `develop` and STOP for manual testing.
7. If testing on `develop` finds a problem, create a new `fix/<description>` or `fix/issue-<number>-<description>` branch from latest `origin/develop`. Follow the same verification and integration flow. Keep fixes as separate commits rather than rewriting original feature commits, then return to `develop` for further testing.
8. Merge `develop` into `main` only when explicitly instructed that testing passed and it is ready for stable/release use. Fetch origin, verify clean synchronized `develop`, reconcile remote changes, and run final tests/lint/build before merging into current `main` and pushing normally. Never automatically merge to `main`. Keep `develop` alive permanently; safely synchronize any newer main changes into it before future feature work.
9. Only bump the application version when preparing a public release/build. During beta, increment only the beta number unless instructed otherwise.
10. Never force-push any branch, rewrite published history, discard unrelated work, or merge with failing checks.

After completion, report the branch, commit, verification results, and merge/push status.
