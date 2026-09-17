Also extend the previous subtitle + playback task with the following requirements.

SUBTITLE USER PREFERENCES

Design subtitle preferences so they can eventually be shared by the web player and Android TV client.

For my installation, the defaults should be:

Default subtitle language:
English (en)

Enabled subtitle languages:

* English (en)
* Macedonian (mk)
* Serbian (sr)
* Croatian (hr)
* Bosnian (bs)

The architecture must allow these settings to be changed later without modifying source code.

If the application already has a settings/configuration system, integrate with it.

Otherwise create a small, clean configuration layer that can later be exposed through a Settings UI.

Do not over-engineer authentication/user profiles yet unless the application already has them.

AUTOMATIC SUBTITLE SELECTION

When a movie or episode starts:

1. Discover torrent/embedded subtitles immediately.
2. Search OpenSubtitles.
3. Search SubDL.
4. Search ALL enabled languages.
5. Normalize results from all providers.
6. Rank subtitles separately within each language.
7. Select the best English subtitle automatically when available.
8. Keep MK/SR/HR/BS available for manual selection.

Do not stop external searches because an English torrent subtitle was found.

For example:

English
✓ Torrent — exact release
• OpenSubtitles — exact release
• SubDL — WEB-DL

Македонски
• OpenSubtitles — WEB-DL

Српски
• SubDL — exact release

Hrvatski
• OpenSubtitles — WEB-DL

Bosanski
• SubDL — WEB-DL

The checkmark represents the currently active subtitle.

ASYNCHRONOUS SUBTITLE DISCOVERY

External subtitle lookup should NOT unnecessarily delay video playback.

Ideal behavior:

Video selected
↓
Playback starts/buffers
↓
Torrent subtitles available immediately
↓
OpenSubtitles + SubDL searched concurrently
↓
Subtitle menu updates when results arrive

If an English torrent subtitle is already available, it may become active immediately.

If there is no English torrent subtitle and an external English subtitle arrives shortly afterward, automatically activate the best English subtitle if the user has not already manually selected another subtitle or turned subtitles Off.

IMPORTANT:

Once the user manually selects:

* another subtitle
* another language
* or Off

do NOT override their selection when later provider results arrive.

Track whether subtitle selection is automatic or user-controlled.

DUPLICATES

OpenSubtitles, SubDL, and the torrent may contain effectively identical subtitles.

Do not clutter the UI unnecessarily.

Implement conservative duplicate detection using appropriate information such as:

* normalized filename
* language
* release name
* subtitle content hash after download where practical

Do not incorrectly merge two subtitles merely because they use the same language.

Different releases may have different synchronization.

Provider/source information should remain available even when results appear equivalent.

SUBTITLE CACHE

Cache downloaded subtitles in a self-hosting-friendly way.

Conceptually:

data/
subtitles/
movies/
shows/

or integrate with the application’s existing cache/data structure.

Cache identity should primarily use stable identifiers rather than human-readable titles.

For example:

TMDB ID
season
episode
provider
subtitle ID

Do not create unsafe paths directly from torrent filenames.

Cache converted WebVTT output when useful so the same SRT does not need to be converted every playback.

SUBTITLE ENCODING

Handle common subtitle encodings correctly.

Do not assume every Balkan subtitle is UTF-8.

Some older Serbian/Croatian/Bosnian/Macedonian subtitles may use legacy encodings.

Detect/handle encoding safely where practical and normalize subtitle text internally to UTF-8 before converting to WebVTT.

Test characters such as:

Macedonian:
Ѓ Ќ Љ Њ Ѕ Џ

Serbian Cyrillic:
Ђ Ј Љ Њ Ћ Џ

Croatian/Bosnian/Serbian Latin:
Č Ć Ž Š Đ

Do not corrupt these characters during download, caching, conversion, or delivery.

SUBTITLE SYNC CONTROLS

Add subtitle timing adjustment if it fits cleanly with the existing player.

The user should be able to adjust subtitle timing, for example:

-5.0s
-2.0s
-1.0s
-0.5s
0.0s
+0.5s
+1.0s
+2.0s
+5.0s

Prefer fine-grained +/- controls rather than requiring only these presets.

Example:

Subtitle delay
[-0.5s]   0.0s   [+0.5s]

This adjustment should affect subtitle presentation only.

It must NOT seek or modify the video.

If the current browser subtitle implementation makes dynamic cue adjustment difficult, explain the cleanest implementation rather than introducing fragile hacks.

PLAYER TIMELINE

For the torrent seeking work, make the timeline visually distinguish:

TOTAL MEDIA DURATION
BUFFERED DATA
CURRENT POSITION

Example:

00:00 ━━━━━━━░░░░░░░●░░░░░░░░░░░░░░ 20:00
↑buffered       ↑ requested seek

The user should be able to click anywhere from 00:00 to 20:00 even if that region is not buffered.

Do NOT set the maximum seekable position based on torrent download progress.

SEEKING BEHAVIOR

Example:

Duration: 45:00
Downloaded/buffered: 00:00–03:20
Current: 02:10

User clicks 31:00.

Expected behavior:

02:10
↓
seek requested: 31:00
↓
show buffering
↓
cancel/deprioritize unnecessary playback-ahead requests around 02:10
↓
request/prioritize torrent pieces needed around 31:00
↓
buffer sufficient data
↓
resume around 31:00

Do NOT download:

03:20 → 31:00

sequentially just to reach the requested position.

SEEK DEBOUNCING

Users may scrub quickly:

10:00
→ 20:00
→ 35:00
→ 41:00

Do not launch expensive permanent torrent/FFmpeg work for every intermediate scrub position.

Debounce/cancel obsolete seek work where appropriate.

The final requested position should receive priority.

The UI itself should remain responsive while scrubbing.

BUFFER-AHEAD

Once playback resumes after a seek, continue prioritizing a reasonable amount of data ahead of the playback position.

Do not buffer the entire remaining movie at highest priority unless the existing torrent strategy intentionally does so.

Make buffer-ahead configurable or centralized so it can later be tuned for:

* slower connections
* faster connections
* Android TV
* browser playback

NETWORK SPEED AWARENESS

Do not require this for the initial implementation, but structure the buffer logic so adaptive behavior could be added later.

For example, my current home connection is approximately:

50 Mbps download
40 Mbps upload

A future implementation could observe actual torrent throughput and increase/decrease buffer-ahead accordingly.

Do NOT hardcode behavior specifically for my connection.

ANDROID TV FUTURE COMPATIBILITY

Keep the playback API independent of the browser UI.

I intend to eventually build:

Android TV
↓
Kotlin / Compose for TV
↓
Media3 / ExoPlayer
↓
my local Next.js server

The Android TV client should eventually be able to request:

* media metadata
* full duration
* playback URL
* subtitle tracks
* subtitle language/source
* HTTP Range video
* HLS fallback when required

Therefore, avoid implementing critical torrent seeking logic only inside browser-specific JavaScript.

Torrent piece prioritization and media access should remain server responsibilities.

API DESIGN

Where appropriate, expose clean media/playback information such as:

{
“duration”: 2700,
“container”: “mkv”,
“videoCodec”: “…”,
“audioCodec”: “…”,
“directPlay”: true,
“rangeSupported”: true,
“hlsAvailable”: true,
“subtitles”: […]
}

Do not blindly create this exact response if the application already has a better API structure.

Integrate with the existing architecture and avoid duplicate endpoints.

IMPORTANT ARCHITECTURAL PRINCIPLE

Keep these layers separate:

Torrent layer
↓
Media/playback layer
↓
Subtitle layer
↓
Client/player

The torrent manager should not contain OpenSubtitles/SubDL UI logic.

Subtitle providers should not control torrent piece selection.

The browser player should not need provider API credentials.

The future Android TV client should not need to understand WebTorrent internals.

FINAL VERIFICATION

After implementation, manually reason through and, where possible, test these scenarios:

SCENARIO A

Movie has:

* embedded English
* OpenSubtitles Macedonian
* SubDL Serbian

Expected:
English automatically active.
All three languages available.

SCENARIO B

Torrent has no subtitles.

OpenSubtitles returns:

* English
* Croatian

SubDL returns:

* English
* Macedonian
* Serbian
* Bosnian

Expected:
Best English subtitle automatically selected.
MK/SR/HR/BS available in menu.

SCENARIO C

User starts a 45-minute episode.

Only first 2 minutes are downloaded.

User seeks to 30:00.

Expected:
Timeline still shows 45:00.
Player buffers.
Torrent prioritizes data around 30:00.
Playback resumes there without downloading minutes 02:00–30:00 sequentially.

SCENARIO D

User seeks rapidly:

10:00 → 20:00 → 35:00

Expected:
Obsolete work is cancelled/deprioritized.
35:00 becomes the effective target.

SCENARIO E

User manually selects Macedonian while OpenSubtitles/SubDL are still loading.

Later a “better” English subtitle arrives.

Expected:
DO NOT switch the user back to English.

SCENARIO F

User selects subtitles Off.

More subtitle results arrive afterward.

Expected:
Subtitles remain Off.

SCENARIO G

OpenSubtitles fails.

Expected:
Video continues normally.
Torrent + SubDL subtitles remain available.

SCENARIO H

SubDL fails.

Expected:
Video continues normally.
Torrent + OpenSubtitles remain available.

SCENARIO I

Both external providers fail.

Expected:
Video continues normally.
Torrent/embedded subtitles remain available.

SCENARIO J

Two viewers use the same season torrent.

Viewer A:
S01E01 at 05:00

Viewer B:
S01E07 at 30:00

Expected:
Both streams continue independently.
One viewer’s seek/file selection must not stop the other’s playback.

Apply these requirements together with the previous combined subtitle + random-access torrent seeking task.