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

When implementing a GitHub issue or a requested change that is intended to be merged:

1. Start from the latest `main` branch.
   - Fetch the latest remote changes.
   - Ensure `main` is up to date before creating the working branch.
   - Do not make implementation commits directly on `main`.

2. Create a new branch for the change.
   - Use a descriptive branch name based on the issue/change.
   - Prefer:
     - `fix/<short-description>` for bug fixes.
     - `feat/<short-description>` for features.
     - `refactor/<short-description>` for refactoring.
   - If a GitHub issue number is available, include it where practical.

3. Implement the requested change.
   - Follow the issue description and acceptance criteria.
   - Keep changes scoped to the task.
   - Add or update relevant tests.
   - Run the appropriate tests and lint before publishing.

4. Bump the application version only when this work is intended to produce a new public build/release.
   - During the current beta cycle, increment only the beta number unless explicitly instructed otherwise.
   - Example: `0.1.0-beta.2` -> `0.1.0-beta.3`.
   - Keep all files containing the application version consistent.
   - Do not create additional version bumps for individual commits within the same release.

5. Commit the completed changes on the working branch.
   - Use a concise conventional commit message where appropriate, for example:
     - `fix: keep subtitles synchronized after seeking`
     - `feat: add native indexer provider`
     - `refactor: decouple torrent search from Jackett`
   - Include the version bump in the same change unless there is a specific reason to separate it.

6. Push the working branch to `origin`.

7. Merge the working branch into `main` only after:
   - Tests pass.
   - Lint passes.
   - The implementation satisfies the requested issue/change.
   - There are no unresolved merge conflicts.
   - The remote `main` has not changed in a way that must first be incorporated.

8. Push the updated `main` branch to `origin`.

9. Do not force-push `main`, rewrite published history, bypass failing tests, or discard unrelated remote changes in order to complete the merge.

10. After completion, report:
    - Branch created.
    - Version before and after, if bumped.
    - Commit hash and message.
    - Tests/lint executed and their results.
    - Whether the branch was pushed.
    - Whether it was successfully merged into `main`.
