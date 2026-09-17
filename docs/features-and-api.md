# Features and API

## Catalog and discovery

The home page shows TMDB movie and TV shelves. Search queries movies and shows by default and supports media-type, genre, and page state in the URL. Discover uses provider-native movie or TV genre filters.

Key metadata endpoints:

- `GET /api/metadata/search?q=alien&type=movie&genre=horror&page=2`
- `GET /api/metadata/discover?type=tv&genre=comedy&page=1`
- `GET /api/metadata/genres?type=all`
- `GET /api/metadata/shows/{id}/seasons/{season}`

`type` accepts `all`, `movie`, or `tv`. Genre values are stable application slugs mapped by the server to TMDB's separate movie and TV genre IDs. Search-side genre totals are approximate because TMDB title search does not offer provider-side genre filtering.

## Source search

Movie and episode pages query Jackett only after the user requests sources. Results are normalized and ranked without exposing API keys or download URLs.

- Direct `.torrent` metadata is inspected for the top 20 relevant candidates.
- Verified playable results appear before unverified magnet fallbacks.
- Proven-incompatible sources are hidden.
- Episode searches require an exact recognized match such as `S02E03` and avoid neighboring episodes.
- Individual, season-pack, multi-season, and complete-series torrents can be reused when they contain the requested episode.
- Individual indexer failures do not discard successful results from other configured indexers.

The source UI uses these forms; the server validates media type, media identity, season, episode, and stored result identity:

- `GET /api/search?q=Movie+Title&type=movie&tmdbId=123&imdbId=tt1234567&year=2024`
- `GET /api/search?q=Show+Title&type=show&tmdbId=456&season=2&episode=3&year=2024`

## Profiles, history, and progress

Profiles are local and server-backed; there are no remote accounts or authentication. The browser remembers only the selected profile ID.

- Profiles have stable IDs and can be renamed or deleted.
- Progress is keyed by profile and TMDB media identity, never by torrent.
- Opening a source creates a zero-position history entry immediately.
- Progress saves every ten seconds and on pause, seek completion, navigation, cleanup, and completion.
- A title is complete at 95%, or at 80% when no more than three minutes remain.
- Completed items remain in History but leave Continue Watching.
- TV history groups a show while retaining each episode's own resume position.

Profile and progress endpoints:

- `GET|POST /api/profiles`
- `PATCH|DELETE /api/profiles/{id}`
- `GET /api/profiles/{id}/continue-watching`
- `GET|DELETE /api/profiles/{id}/history`
- `GET|PUT /api/profiles/{id}/progress`
- `POST /api/profiles/{id}/playback-sessions`

## Next episode and autoplay

TMDB must confirm that a real next episode exists. TorPlay first checks the active torrent using its exact episode matcher. Only when the episode is absent does it perform the normal ranked Jackett search.

The player exposes the next-episode action during the final two minutes. **Play Now** advances immediately; automatic advancement otherwise occurs only when playback genuinely ends. Cancelling disables automatic advancement for that episode.

- `POST /api/playback/next-episode`

## Torrent sessions and files

Torrent APIs use opaque, validated session and file identifiers:

- `POST /api/torrents` starts a validated source.
- `GET|DELETE /api/torrents/{id}` reads or releases a session.
- `POST /api/torrents/{id}/release` provides idempotent page-exit cleanup.
- `/api/torrents/{id}/files/{fileId}/stream` serves native video with Range support.
- `/api/torrents/{id}/files/{fileId}/playback` prepares, reads, or stops converted playback.
- `/api/torrents/{id}/files/{fileId}/hls/{asset}` serves prepared manifests and media assets.

The browser never receives a torrent client or direct swarm connection.

## Video player

The custom player includes keyboard controls, playback speed, picture-in-picture, fullscreen, playback status, peers, transfer speed, downloaded bytes, captions, subtitle delay, and subtitle appearance controls.

Native MP4, M4V, and WebM support HTTP Range seeking. Recognized non-native containers—including MKV, AVI, MOV, MPEG, transport streams, VOB, OGM/OGV, 3GP, DIVX, WMV, and FLV—use FFmpeg preparation when possible.

## Subtitles

Torrent `.srt` and `.vtt` sidecars are downloaded by the server and delivered as WebVTT. TorPlay can also expose embedded tracks and configured OpenSubtitles/SubDL results.

- Captions remain off until enabled.
- Automatic English selection yields permanently to a manual language or Off choice for that playback.
- Subtitle delay belongs to the current playback.
- Appearance preferences are validated and retained on the current browser device.

Subtitle endpoints:

- `GET|POST /api/torrents/{id}/files/{fileId}/subtitles`
- `GET /api/torrents/{id}/files/{fileId}/subtitles/{trackId}`
- `GET /api/torrents/{id}/subtitles/{subtitleId}`

## Health

- `GET /api/health` returns a small, non-cacheable, secret-free service response used by supervisors and diagnostics.
