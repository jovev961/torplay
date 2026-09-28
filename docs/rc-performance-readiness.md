# RC performance and readiness audit

Issue: #139. TV navigation work: #138.

## Method

- Use a production standalone build and the packaged runtime, never `next dev`.
- Record five runs and compare medians and ranges on the same machine, network, profile and source configuration.
- Run `npm run audit:rc -- --base-url=http://127.0.0.1:3000 --runs=5` for health, home, settings, profiles and runtime-size evidence.
- Record source-search time to first progressive result and completion separately.
- Record click-to-playing, seek-to-playing, subtitle switch and audio switch with browser Network/Performance tools.
- Compare browser heap and TorPlay RSS before and after ten browse -> play -> back cycles, then again after the normal cleanup window.

## Confirmed baseline and result

| Check | Baseline | Final |
| --- | ---: | ---: |
| Standalone runtime | 353 MB | 228 MB |
| Standalone `node_modules` | 190 MB | 190 MB |
| Standalone `.next` | 18 MB | 18 MB |
| Unrelated nested `dist` artifact | 112 MB | absent |
| Source/tests/docs traced into runtime | present | absent |
| Turbopack whole-project trace warning | present | absent |
| Full automated suite | 560 passing | 567 passing |

The measured 125 MB reduction (35%) comes from preventing the dynamic FFmpeg process call from causing whole-project output tracing. The runtime still contains Next.js, `better-sqlite3`, FFmpeg/FFprobe and the other standalone dependencies required at runtime. Release staging now strips private `.env*` files and rejects source-only directories.

### Production endpoint sample

Recorded from the standalone server on 2026-09-28, five complete-response runs per route. The first sample is retained to show cold-route cost; the median describes the steady result.

| Route | First run | Median | Range | Status |
| --- | ---: | ---: | ---: | ---: |
| `/api/health` | 36.61 ms | 1.81 ms | 1.55-36.61 ms | 200 |
| `/` | 1027.61 ms | 25.83 ms | 22.39-1027.61 ms | 200 |
| `/api/settings` | 129.11 ms | 27.67 ms | 26.79-129.11 ms | 200 |
| `/api/profiles` | 3.42 ms | 0.98 ms | 0.82-3.42 ms | 200 |

The audit counted 211,742,182 bytes across 2,535 standalone runtime files. Network-dependent source and playback timings remain part of the real-package/device checklist because local source-tree execution cannot validate them.

## RC regression checklist

- [ ] Windows installer: clean install, launch, restart, upgrade with retained data, uninstall/reinstall.
- [ ] Ubuntu `.deb`: clean install, launch, restart, upgrade with retained data, uninstall/reinstall.
- [ ] Fedora `.rpm`: clean install, launch, restart, upgrade with retained data, uninstall/reinstall.
- [ ] Browser/LAN: home, settings, profiles, source configuration, movie/show playback, seek/resume, subtitles, audio, history and Continue Watching.
- [ ] BrowseHere TV: 1080p/4K layout, long rows/labels, D-pad focus, Enter, Back, dialogs, source selection and player menus.
- [ ] Configured debrid paths and ten-cycle memory/cleanup check.

The platform and physical-TV rows require their real release artifacts and devices. They remain release gates and must not be inferred from source-tree tests.

## Remaining RC dependencies

- Complete the physical BrowseHere check and attach results to issue #138.
- Complete Windows, Ubuntu and Fedora artifact checks after both packaging workflows succeed.
- Complete the separate macOS application prerequisite before cutting an RC tag.
