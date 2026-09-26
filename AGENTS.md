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

When asked to implement one or more GitHub issues:

1. Read the complete issue description and acceptance criteria before modifying code.
2. Treat each issue as its own task specification.
3. Inspect the relevant existing implementation before making changes.
4. For bugs, reproduce the problem or establish the root cause before implementing a fix.
5. Keep changes scoped to the issue. Avoid unrelated refactoring.
6. Add or update relevant tests.
7. Run appropriate tests, lint, and build verification before completing the task.
8. Report the approach, changed files, tests, and verification results.

When multiple issues are requested, keep their implementation scope logically separated even if they are worked on during the same session.

Do not perform Git or GitHub workflow operations merely because the task came from a GitHub issue.

---

## Git and GitHub Workflow

Git and GitHub operations are **opt-in only**.

Unless the user explicitly asks to use Git or GitHub in the current request:

- Do not create or switch branches.
- Do not stage files with `git add`.
- Do not create commits.
- Do not push branches.
- Do not create, update, or merge pull requests.
- Do not delete branches.
- Do not modify published Git history.
- Do not promote `develop` to `main`.

Implement requested code changes only in the current working tree.

Mentioning a GitHub issue, issue number, branch name, or pull request does **not** by itself authorize Git/GitHub operations.

### Branch model

When the user explicitly asks to use the Git/GitHub workflow:

- `main` is the stable/release branch.
- `develop` is the integration/manual-testing branch.
- Normal implementation work uses scoped `feat/...`, `fix/...`, or `refactor/...` branches.
- Never directly push implementation changes to `main` or `develop`.
- Never force-push or rewrite published history unless explicitly instructed.

### One or multiple issues

The workflow must support any number of requested issues.

Each independent issue should normally have its own:

- branch,
- changes,
- commit(s),
- push,
- pull request into `develop`,
- merge.

Do not combine unrelated issues into one branch or pull request unless the user explicitly asks for a combined change.

Multiple issue branches and pull requests may be open at the same time.

For example:

```text
develop
  ├── feat/issue-101-...
  ├── fix/issue-102-...
  ├── feat/issue-103-...
  └── fix/issue-104-...