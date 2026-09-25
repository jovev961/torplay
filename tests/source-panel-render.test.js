import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

test("SourcePanel renders before any debrid file review state exists", async () => {
  const built = await build({
    entryPoints: [path.resolve("components/SourcePanel.js")],
    bundle: true, platform: "node", format: "cjs", write: false,
    jsx: "automatic", loader: { ".js": "jsx" },
    external: ["react", "react-dom", "next/*"],
  });
  const loadedModule = { exports: {} };
  new Function("require", "module", "exports", built.outputFiles[0].text)(
    createRequire(import.meta.url), loadedModule, loadedModule.exports,
  );
  const SourcePanel = loadedModule.exports.default;
  const lookup = { session: null, debridJob: null, debridChoice: null,
    results: [], usenetResults: [], usenetJobs: [], error: "", errorCode: "",
    searching: false, hasSearched: false, usenetEnabled: false };
  const html = renderToStaticMarkup(createElement(SourcePanel, {
    lookup, heading: "Episode", episode: { season: 1, number: 1 },
  }));
  assert.match(html, /Authorized sources/);
});

test("debrid episode panel keeps unmapped provider files out of the normal episode grid", async () => {
  const built = await build({
    entryPoints: [path.resolve("components/SourcePanel.js")],
    bundle: true, platform: "node", format: "cjs", write: false,
    jsx: "automatic", loader: { ".js": "jsx" },
    external: ["react", "react-dom", "next/*"],
  });
  const loadedModule = { exports: {} };
  new Function("require", "module", "exports", built.outputFiles[0].text)(
    createRequire(import.meta.url), loadedModule, loadedModule.exports,
  );
  const SourcePanel = loadedModule.exports.default;
  const html = renderToStaticMarkup(createElement(SourcePanel, {
    heading: "Episode", episode: { season: 1, number: 3 },
    lookup: { session: { id: "session", status: "ready", backend: "debrid",
      provider: "real-debrid", files: [
        { id: "0", name: "Unknown A.mkv", size: 1000 },
        { id: "1", name: "Unknown B.mkv", size: 1000 },
      ] }, results: [], usenetResults: [], usenetJobs: [], error: "", errorCode: "",
      searching: false, hasSearched: true, usenetEnabled: false },
  }));
  assert.match(html, /Map the file in/);
  assert.match(html, /Debrid Library/);
  assert.doesNotMatch(html, /Episodes in this source|Unknown A\.mkv|Unknown B\.mkv/);
});

test("active debrid playback hides the empty search notice and shows a clear stop action", async () => {
  const built = await build({
    entryPoints: [path.resolve("components/SourcePanel.js")],
    bundle: true, platform: "node", format: "cjs", write: false,
    jsx: "automatic", loader: { ".js": "jsx" },
    external: ["react", "react-dom", "next/*"],
  });
  const loadedModule = { exports: {} };
  new Function("require", "module", "exports", built.outputFiles[0].text)(
    createRequire(import.meta.url), loadedModule, loadedModule.exports,
  );
  const SourcePanel = loadedModule.exports.default;
  const lookup = { session: { id: "session", status: "ready", backend: "debrid",
    provider: "real-debrid", files: [{ id: "1", name: "Episode.mkv", size: 1000,
      playbackMode: "transcode" }] },
    selectedFileId: "1", stop() {}, results: [], usenetResults: [], usenetJobs: [],
    error: "", errorCode: "", searching: false, hasSearched: true, usenetEnabled: false };
  const active = renderToStaticMarkup(createElement(SourcePanel, { lookup, heading: "Episode" }));
  assert.match(active, /class="sourceStopButton"[^>]*>Stop playback<\/button>/);
  assert.match(active, /Change source/);
  assert.match(active, /Ready through Real-Debrid/);
  assert.doesNotMatch(active, /No usable authorized sources were found/);

  const stopped = renderToStaticMarkup(createElement(SourcePanel, {
    lookup: { ...lookup, session: null }, heading: "Episode",
  }));
  assert.match(stopped, /No usable authorized sources were found/);

  const automatic = renderToStaticMarkup(createElement(SourcePanel, {
    lookup, heading: "Episode", playback: { autoStart: true },
  }));
  assert.match(automatic, /Buffering torrent data, probing codecs, and preparing playback/);
  assert.doesNotMatch(automatic, /Prepare &amp; play|Prepare & play/);
  assert.match(active, /Prepare &amp; play/);

  const episodeControls = renderToStaticMarkup(createElement(SourcePanel, {
    lookup, heading: "Episode", playback: {
      onPreviousEpisode() {}, onNextEpisode() {},
      hasPreviousEpisode: true, hasNextEpisode: false,
    },
  }));
  assert.match(episodeControls, /aria-label="Previous episode"/);
  assert.match(episodeControls, /aria-label="Next episode"[^>]*disabled/);

  const nextEpisode = renderToStaticMarkup(createElement(SourcePanel, {
    lookup, heading: "Episode", playback: { nextEpisodePrompt: { kind: "ready",
      title: "Next episode is ready", text: "S01E02 · The next story",
      action: "Play now", onAction() {}, secondaryAction: "Cancel", onSecondaryAction() {},
    } },
  }));
  assert.doesNotMatch(nextEpisode, /class="playerEpisodePrompt"/);
});

test("source panel offers ready library playback and shows torrent provider status before selection", async () => {
  const built = await build({
    entryPoints: [path.resolve("components/SourcePanel.js")],
    bundle: true, platform: "node", format: "cjs", write: false,
    jsx: "automatic", loader: { ".js": "jsx" },
    external: ["react", "react-dom", "next/*"],
  });
  const loadedModule = { exports: {} };
  new Function("require", "module", "exports", built.outputFiles[0].text)(
    createRequire(import.meta.url), loadedModule, loadedModule.exports,
  );
  const html = renderToStaticMarkup(createElement(loadedModule.exports.default, {
    heading: "Sources", lookup: {
      session: null, hasSearched: true, searching: false, startingId: null,
      results: [{ id: "torrent-1", title: "Show S01", canStart: true, indexer: "Index",
        size: 1000, seeders: 4, verification: "verified", hasMagnet: true }],
      readySources: [{ provider: "real-debrid", resourceId: "ready-1", name: "Show pack" }],
      torrentAvailability: { "torrent-1": { availability: { "real-debrid": "ready", torbox: "not-ready" } } },
      usenetResults: [], usenetJobs: [], error: "", errorCode: "", usenetEnabled: false,
    },
  }));
  assert.match(html, /Watch with Real-Debrid/);
  assert.match(html, /Real-Debrid: Ready/);
  assert.match(html, /TorBox: Not ready/);
  assert.match(html, /Choose torrent/);
  assert.doesNotMatch(html, /Prepare &amp; play/);
});
