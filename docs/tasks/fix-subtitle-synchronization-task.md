# Task: Fix Subtitle Synchronization After Resume and Seeking

## Problem

TorPlay has a subtitle synchronization bug during playback.

### Continue Watching / Resume

1. Start a movie or TV episode with subtitles enabled.
2. Watch long enough for playback progress to be saved.
3. Leave playback.
4. Resume through **Continue Watching**.
5. The video resumes at the correct saved position, but the subtitles are out of sync.

### Seeking

1. Start playback with correctly synchronized subtitles.
2. Seek forward or backward.
3. Subtitle timing becomes incorrect.
4. Repeated seeking may make the synchronization increasingly wrong.

## Expected Behavior

Subtitle cues must always remain tied to the video's actual media timeline.

For example, if a subtitle cue belongs at `00:20:15`:

- Normal playback should display it at `00:20:15`.
- Resuming playback at `00:20:00` should still display it at `00:20:15`.
- Seeking from `00:10:00` to `00:20:00` should still display it at `00:20:15`.
- Seeking backward and forward multiple times must not accumulate any timing offset.

Resume and seek operations should change the video's playback position. They must not permanently modify or repeatedly offset subtitle cue timestamps.

## Investigation

Inspect the existing playback and subtitle implementation before making changes.

Trace:

- How subtitle files and cues are loaded.
- How subtitle timestamps are parsed or transformed.
- How subtitle tracks are attached to the video.
- How Continue Watching restores the saved playback position.
- How seeking is handled.
- Whether any subtitle offset is calculated from the stream start position, saved playback position, seek position, or `currentTime`.
- Whether subtitle timestamps are being mutated multiple times.
- Whether switching/reloading subtitle tracks introduces another offset.
- Whether the streaming or transcoding layer starts media at an offset that needs to be accounted for.

Determine the actual root cause. Do not apply a hardcoded timing correction just to hide the issue.

## Requirements

Fix subtitle synchronization so that:

- Subtitles remain synchronized after Continue Watching / resume.
- Subtitles remain synchronized after seeking forward.
- Subtitles remain synchronized after seeking backward.
- Multiple seeks do not accumulate timing errors.
- Switching subtitle tracks after seeking remains synchronized.
- Disabling and re-enabling subtitles does not introduce an offset.
- Normal playback from the beginning continues to work.
- Movie playback works correctly.
- TV episode playback works correctly.
- Existing playback progress and resume behavior is preserved.
- Existing subtitle provider and cache behavior is preserved.

Prefer one authoritative media timeline, with subtitle display derived from the video's actual playback position.

Do not use arbitrary delays, timers, or hardcoded offsets to mask the bug.

## Testing

Add or update automated tests where practical, especially for any subtitle timestamp or offset calculations.

Cover or reason through at least these cases:

1. Start at `00:00` -> subtitles synchronized.
2. Resume saved playback around 20 minutes -> subtitles synchronized.
3. Seek forward -> subtitles synchronized.
4. Seek backward -> subtitles synchronized.
5. Perform several forward/backward seeks -> no accumulated drift.
6. Resume -> seek -> change subtitle track -> synchronized.
7. Disable and re-enable subtitles after seeking -> synchronized.
8. Resume a TV episode with saved progress -> synchronized.

Run the existing test suite and lint after the implementation.

## Scope

Keep the change focused on subtitle synchronization.

Do not refactor unrelated application functionality.

Do not change existing playback progress semantics unless required to fix the root cause.

## Completion Report

After implementing the fix, report:

- The root cause.
- Files changed.
- How subtitle timing worked before the fix.
- How subtitle timing works after the fix.
- Tests added or changed.
- Test and lint results.
