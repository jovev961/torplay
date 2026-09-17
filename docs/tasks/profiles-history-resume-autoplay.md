# TorPlay Profiles, History, Resume & Next Episode

Implement lightweight Netflix-style local profiles with per-profile watch history, Continue Watching, resume support, and automatic next-episode playback.

Follow `AGENTS.md` for project-wide architecture, coding style, validation, simplicity, and scope rules.

Do not add authentication, accounts, passwords, email, permissions, or avatars.

## 1. Audit first

Before changing code, inspect and briefly report:
- current movie/show/season/episode identifiers
- whether TMDB IDs are available during playback
- torrent-session creation/reuse
- existing episode-file matching for season packs
- playback progress/end handling
- current temporary/persistent storage
- modules that should own profiles, history, and next-episode resolution

Then implement the full task. Do not stop after the audit.

## 2. Profiles

Profiles only need a stable internal ID and display name, plus timestamps if useful.

Conceptually:

```js
{
  id,
  name,
  createdAt,
  updatedAt
}
```

Support:
- create
- rename
- delete
- switch
- remember selected profile on the current browser/device

Deleting a profile should remove its history.
Do not use the profile name as the storage key.

Initial UX:

```text
Who's watching?

[Vasil]
[Filip]
[Guest]

[Add Profile]
```

If there are no profiles, show only `[Add Profile]`.

## 3. Persistence

Use server-side SQLite unless the project already has a clearly better persistent database layer.

Preferred default:

```text
persistent-data/torplay.db
```

Requirements:
- add persistent storage directory to `.gitignore`
- optionally support `TORPLAY_DATABASE_PATH`
- keep it separate from temporary torrent/subtitle data
- survive browser refresh, app restart, Jackett restart, torrent cleanup, and machine reboot
- do not use `localStorage` as the source of truth for history

## 4. Watch history and progress

History belongs to a profile and is keyed by stable media identity, never torrent identity.

Movie identity should include:
- profile ID
- movie/TMDB ID
- position
- duration
- completed
- last watched time

TV identity should include:
- profile ID
- show/TMDB ID
- season number
- episode number
- position
- duration
- completed
- last watched time

Changing torrent/source must not lose progress.

Example:

```text
Alien watched to 34:21 using Torrent A
Torrent A later dies
Alien opened using Torrent B
→ resume at 34:21
```

Save progress periodically, not on every `timeupdate`.

Use a sensible interval, roughly 5-15 seconds, plus immediate saves where practical on:
- pause
- seek completion
- source switch
- player close/navigation
- playback ended

Validate progress values. Reject or normalize negative/NaN/impossible values.

The server should calculate completion rather than trusting a client-provided percentage.

Prevent stale requests from moving progress backwards.

Example:

```text
10:00 save starts
user seeks to 35:00
35:00 saves
old 10:00 request finishes later
```

Expected: saved position remains `35:00`.

Use a simple mechanism such as timestamps or sequence numbers.
Intentional "Play from beginning" must still be able to reset progress.

## 5. Continue Watching, resume and history

Add a Continue Watching shelf near the top of Home for the active profile.

Show unfinished media only.

Movie cards should show:
- title
- existing poster/backdrop style
- progress bar
- current time / duration

TV cards should show:
- show title
- season + episode
- episode title if already available
- progress bar
- current time / duration

Sort by most recently watched.
Do not show an empty Continue Watching shelf.

Centralize thresholds. Sensible defaults:

```text
minimum before Continue Watching: 30 seconds
completed: >= 95% OR only a few minutes remain
```

Adjust after inspecting the current player if needed.

Completed media:
- leaves Continue Watching
- remains in Watch History

When unfinished progress exists, offer:

```text
Resume from 34:21
Start from beginning
```

For TV:

```text
Resume S02E05 at 27:14
```

Do not resume when:
- progress is too small
- media is completed
- saved progress is invalid

Resume must use existing random-access seeking. Do not sequentially download from the beginning to reach the resume point.

If completed media is opened again, start from the beginning by default.

Add a simple Watch History view/section showing:
- movie/show
- season + episode for TV
- progress
- completed state
- last watched time

Where cleanly appropriate provide:
- Resume
- Play from beginning
- Remove from history / Continue Watching

Keep this lightweight.

## 6. Profile isolation

Profiles must be independent.

Example:

```text
Vasil: Alien @ 34:21
Filip: Alien @ 1:03:12
Guest: not watched
```

Switching profile must immediately show the correct Continue Watching/history state.
One profile must never overwrite another profile's progress.

## 7. Episode completion and autoplay

When a TV episode ends:
1. save completion immediately
2. determine the next real episode from metadata
3. do not invent episode numbers
4. if no next episode exists, stop cleanly

Examples:

```text
S02E05 → S02E06
S02E13 → S03E01
```

Only continue if metadata confirms the next episode exists.

### Reuse current torrent first

This is a key requirement.

If the active torrent already contains the next episode, reuse it.

Example current torrent:

```text
Show.S01E01.mkv
Show.S01E02.mkv
Show.S01E03.mkv
Show.S01E04.mkv
Show.S01E05.mkv
```

User finishes `S01E04`.

Expected:

```text
resolve next = S01E05
→ inspect current torrent
→ S01E05 exists
→ reuse current torrent session
→ select/prioritize S01E05
→ start playback
```

Do not search Jackett unnecessarily.

Reuse existing episode-file matching rather than creating another parser.

This must also work with:
- season packs
- multi-season packs
- complete-series packs

### Fallback source search

If the current torrent does not contain the next episode:

```text
episode ends
→ resolve next episode
→ not in current torrent
→ use existing Jackett/source-search flow
→ choose best valid source
→ start next episode
```

Reuse existing:
- source search
- validation
- ranking
- torrent startup
- playback flow

Do not create a separate autoplay-specific search/ranking system.
Do not blindly choose the first Jackett result.

If no usable source is found:

```text
Could not automatically find a playable source for S01E05.

[Choose Source]
[Back to Show]
```

Do not leave the player loading forever.

### Autoplay UX

When the next episode is ready:

```text
Next episode starts in 10 seconds

[Play Now]
[Cancel]
```

Requirements:
- centralized/configurable countdown
- user can cancel
- Play Now skips countdown
- no forced instant switch
- no autoplay if there is no next episode
- no autoplay if next-episode/source resolution fails

The browser can own the countdown UI.
Core next-episode resolution should remain reusable server-side logic.

When an episode completes:
- remove it from unfinished Continue Watching
- keep it in history
- do not add the next episode to Continue Watching at `0:00`

Only add the next episode after meaningful playback actually begins.

## 8. APIs and architecture

Expose reusable server APIs following existing project conventions.

Conceptually:

```text
GET    /api/profiles
POST   /api/profiles
PATCH  /api/profiles/{id}
DELETE /api/profiles/{id}
```

History/progress conceptually:

```text
GET    /api/profiles/{id}/history
GET    /api/profiles/{id}/continue-watching
PUT    /api/profiles/{id}/progress
DELETE /api/profiles/{id}/history/{media}
```

The exact route shape may differ if existing conventions are better.

These APIs must be reusable by a future Android TV client.

Keep responsibilities separated:
- no SQLite logic directly in React components
- no profile/history persistence in WebTorrent manager
- no Jackett search logic in history service

Conceptually:

```text
Profile / History
      ↓
Playback orchestration
      ↓
Media
      ↓
Torrent
```

Next episode:

```text
Metadata
   ↓
next-episode resolver
   ↓
playback orchestration
   ↓
reuse current torrent OR source search
```

## 9. Failure behavior

Profile/history problems must not break normal playback.

Expected:
- progress save fails → playback continues
- Continue Watching fails → Home still loads normal shelves
- next-episode metadata fails → current episode remains completed and a useful message is shown
- automatic source search fails → offer manual source selection

## 10. Tests

Add focused tests where practical.

Profiles:
- create / rename / delete
- stable ID survives rename
- profile history isolation

Progress:
- save movie progress
- save episode progress
- resume unfinished media
- completed media excluded from Continue Watching
- changing torrent keeps progress
- stale update cannot overwrite newer progress
- invalid values handled safely

Continue Watching:
- sorted by recent activity
- tiny accidental playback excluded
- completed items excluded
- empty state

Next episode:
- normal next episode
- season boundary
- final episode has no next episode
- current torrent contains next episode → reuse
- current torrent does not contain next episode → source search
- multi-season pack reuse

Autoplay:
- countdown
- Play Now
- Cancel
- no autoplay when no next episode
- graceful source-search failure

Mock external providers/torrent behavior where practical.
Do not make tests depend on live TMDB, Jackett, trackers, or peers.

## 11. Do not break existing features

Do not break:
- movie/show browsing
- Search/Discover
- detail pages
- season/episode selection
- Jackett search
- torrent validation
- season packs
- WebTorrent playback
- random-access seeking
- HTTP Range streaming
- FFmpeg playback
- subtitles / OpenSubtitles / SubDL
- concurrent playback sessions

## 12. Completion report

When finished, report:
- files added/modified
- SQLite path/schema
- profile API
- history/progress API
- Continue Watching behavior
- resume behavior
- completion thresholds
- progress-save interval
- stale-update protection
- next-episode resolution
- current-torrent reuse
- Jackett fallback
- autoplay behavior
- tests and results
- lint result
- build result
- remaining limitations

Run:

```bash
npm test
npm run lint
npm run build
```

Fix regressions introduced by this task before finishing.

## Expected UX summary

Movie:

```text
Vasil watches Alien
stops at 34:21

Home:
Continue Watching
Alien - 34:21 / 1:57:00

Later:
Resume from 34:21
or
Start from beginning
```

TV with bundled torrent:

```text
S01E04 ends
→ next = S01E05
→ S01E05 exists in current torrent
→ reuse torrent
→ Next episode starts in 10...
   [Play Now] [Cancel]
```

TV with single-episode torrent:

```text
S01E04 ends
→ next = S01E05
→ not in current torrent
→ normal Jackett source search
→ best valid source
→ Next episode starts in 10...
   [Play Now] [Cancel]
```

End of show:

```text
final episode ends
→ mark completed
→ no next episode
→ no autoplay/search
```
