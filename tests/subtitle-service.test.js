import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  loadSubtitleTrack,
  publicSubtitleDiscovery,
  startSubtitleDiscovery,
} from "../lib/subtitles/service.js";
import { subtitleCachePath } from "../lib/subtitles/cache.js";
import { applyAutomaticSubtitle } from "../lib/subtitles/selection.js";
import { subtitleConfig as readSubtitleConfig } from "../lib/subtitles/config.js";

function subtitleConfig(overrides = {}) {
  return {
    defaultLanguage: "en",
    enabledLanguages: ["en", "mk", "sr", "hr", "bs"],
    cachePath: ".data/subtitles",
    cacheTtlDays: 30,
    opensubtitles: { apiKey: "open-key", userAgent: "TorPlay tests" },
    subdl: { apiKey: "subdl-key" },
    bufferAheadSeconds: 60,
    ...overrides,
  };
}

function seasonSession() {
  const files = [
    { name: "video.mkv", path: "Show/Season 01/Episode 01/video.mkv", length: 1_000 },
    { name: "English.srt", path: "Show/Season 01/Episode 01/English.srt", length: 50 },
    { name: "video.mkv", path: "Show/Season 01/Episode 02/video.mkv", length: 1_000 },
    { name: "English.srt", path: "Show/Season 01/Episode 02/English.srt", length: 50 },
  ];
  return {
    id: "session-one",
    resource: { torrent: { files } },
    subtitleDiscoveries: new Map(),
    releaseName: "Show.S01E01.1080p.WEB-DL",
    mediaContext: { type: "show", tmdbId: 123, season: 1, episode: 1 },
  };
}

function providerResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("reads built-in subtitle defaults and server tuning from configuration", () => {
  assert.deepEqual(readSubtitleConfig({}), {
    defaultLanguage: "en",
    enabledLanguages: ["en", "mk", "sr", "hr", "bs"],
    cachePath: ".data/subtitles",
    cacheTtlDays: 30,
    opensubtitles: { apiKey: null, userAgent: "TorPlay v0.1" },
    subdl: { apiKey: null },
    bufferAheadSeconds: 60,
  });
  const configured = readSubtitleConfig({
    SUBTITLE_DEFAULT_LANGUAGE: "mk",
    SUBTITLE_LANGUAGES: "mk,en",
    SUBTITLE_CACHE_PATH: "/tmp/torplay-subtitles",
    SUBTITLE_CACHE_TTL_DAYS: "14",
    PLAYBACK_BUFFER_AHEAD_SECONDS: "90",
  });
  assert.equal(configured.defaultLanguage, "en");
  assert.deepEqual(configured.enabledLanguages, ["en", "mk", "sr", "hr", "bs"]);
  assert.equal(configured.cachePath, "/tmp/torplay-subtitles");
  assert.equal(configured.cacheTtlDays, 14);
  assert.equal(configured.bufferAheadSeconds, 90);
  assert.throws(
    () => readSubtitleConfig({ SUBTITLE_CACHE_TTL_DAYS: "0" }),
    /must be a positive number/,
  );
  assert.throws(
    () => readSubtitleConfig({ SUBTITLE_CACHE_PATH: "   " }),
    /must not be empty/,
  );
});

test("discovers torrent subtitles immediately and searches both external providers concurrently", async () => {
  const session = seasonSession();
  const pending = new Map();
  const calls = [];
  const fetchImpl = (url) => {
    const provider = String(url).includes("opensubtitles") ? "opensubtitles" : "subdl";
    calls.push(provider);
    return new Promise((resolve) => pending.set(provider, resolve));
  };
  const discovery = startSubtitleDiscovery(session, session.resource.torrent.files[0], {
    config: subtitleConfig(),
    fetchImpl,
    probeMedia: async () => ({ subtitleStreams: [] }),
  });

  assert.equal(discovery.state, "loading");
  assert.deepEqual(discovery.tracks.map((track) => track.language), ["en"]);
  assert.equal(discovery.rawTracks[0].torrentFileId, "1");

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(new Set(calls), new Set(["opensubtitles", "subdl"]));
  pending.get("opensubtitles")(providerResponse({
    data: [{
      attributes: {
        language: "mk",
        release: "Show.S01E01.1080p.WEB-DL",
        files: [{ file_id: 11, file_name: "Show.S01E01.mk.srt" }],
      },
    }],
  }));
  pending.get("subdl")(providerResponse({
    subtitles: [{
      n_id: 22,
      language: "sr",
      season: 1,
      episode: 1,
      release_name: "Show.S01E01.1080p.WEB-DL",
      name: "Show.S01E01.sr.srt",
    }],
  }));
  await discovery.done;

  assert.equal(discovery.state, "ready");
  assert.deepEqual(discovery.providers, {
    torrent: "ready",
    embedded: "ready",
    opensubtitles: "ready",
    subdl: "ready",
  });
  assert.deepEqual(new Set(discovery.tracks.map((track) => track.language)), new Set(["en", "mk", "sr"]));
});

test("keeps successful local and provider tracks when another provider fails", async () => {
  const session = seasonSession();
  const discovery = startSubtitleDiscovery(session, session.resource.torrent.files[0], {
    config: subtitleConfig(),
    probeMedia: async () => ({
      subtitleStreams: [{ index: 4, language: "hr", title: "Croatian", textBased: true }],
    }),
    fetchImpl: async (url) => {
      if (String(url).includes("opensubtitles")) throw new Error("offline");
      return providerResponse({
        subtitles: [{ n_id: 9, language: "bs", season: 1, episode: 1, name: "Show.S01E01.bs.srt" }],
      });
    },
  });
  await discovery.done;

  assert.equal(discovery.providers.opensubtitles, "failed");
  assert.equal(discovery.providers.subdl, "ready");
  assert.deepEqual(new Set(discovery.tracks.map((track) => track.language)), new Set(["en", "hr", "bs"]));
});

test("automatic English selection yields permanently to manual language or Off choices", () => {
  const first = {
    preferences: { defaultLanguage: "en" },
    tracks: [{ id: "torrent-en", language: "en" }, { id: "mk", language: "mk" }],
  };
  assert.deepEqual(applyAutomaticSubtitle({ mode: "automatic", activeId: null }, first), {
    mode: "automatic",
    activeId: "torrent-en",
  });

  const later = {
    preferences: { defaultLanguage: "en" },
    tracks: [{ id: "better-en", language: "en" }, { id: "mk", language: "mk" }],
  };
  assert.deepEqual(applyAutomaticSubtitle({ mode: "user", activeId: "mk" }, later), {
    mode: "user",
    activeId: "mk",
  });
  assert.deepEqual(applyAutomaticSubtitle({ mode: "user", activeId: null }, later), {
    mode: "user",
    activeId: null,
  });
});

test("public subtitle tracks expose opaque IDs and client routes without provider credentials", async () => {
  const session = seasonSession();
  const discovery = startSubtitleDiscovery(session, session.resource.torrent.files[0], {
    config: subtitleConfig({
      opensubtitles: { apiKey: null, userAgent: "TorPlay tests" },
      subdl: { apiKey: null },
    }),
    probeMedia: async () => ({ subtitleStreams: [] }),
  });
  await discovery.done;
  const publicResult = publicSubtitleDiscovery(session, "0", discovery);
  assert.match(publicResult.tracks[0].id, /^[0-9a-f-]{36}$/);
  assert.equal(publicResult.tracks[0].src.includes("open-key"), false);
  assert.equal(publicResult.tracks[0].src.includes("subdl-key"), false);
  assert.match(publicResult.tracks[0].src, /\/files\/0\/subtitles\//);
});

test("restarts discovery when a profile changes its subtitle preferences", async () => {
  const session = seasonSession();
  const providerless = {
    opensubtitles: { apiKey: null, userAgent: "TorPlay tests" },
    subdl: { apiKey: null },
  };
  const first = startSubtitleDiscovery(session, session.resource.torrent.files[0], {
    config: subtitleConfig({ ...providerless, defaultLanguage: "en", enabledLanguages: ["en"] }),
    probeMedia: async () => ({ subtitleStreams: [] }),
  });
  await first.done;
  const unchanged = startSubtitleDiscovery(session, session.resource.torrent.files[0], {
    config: subtitleConfig({ ...providerless, defaultLanguage: "en", enabledLanguages: ["en"] }),
    probeMedia: async () => ({ subtitleStreams: [] }),
  });
  assert.equal(unchanged, first);

  const changed = startSubtitleDiscovery(session, session.resource.torrent.files[0], {
    config: subtitleConfig({ ...providerless, defaultLanguage: "de", enabledLanguages: ["de", "en"] }),
    probeMedia: async () => ({ subtitleStreams: [] }),
  });
  await changed.done;
  assert.notEqual(changed, first);
  assert.deepEqual(changed.preferences, {
    defaultLanguage: "de",
    enabledLanguages: ["de", "en"],
  });
});

test("loaded cached tracks are protected by their session and reused without extraction", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "torplay-subtitle-service-"));
  try {
    const config = subtitleConfig({
      cachePath: root,
      opensubtitles: { apiKey: null, userAgent: "TorPlay tests" },
      subdl: { apiKey: null },
    });
    const session = seasonSession();
    const discovery = startSubtitleDiscovery(session, session.resource.torrent.files[0], {
      config,
      probeMedia: async () => ({
        subtitleStreams: [{ index: 4, language: "hr", title: "Croatian", textBased: true }],
      }),
    });
    await discovery.done;
    const track = discovery.tracks.find((candidate) => candidate.provider === "embedded");
    let extractions = 0;

    const first = await loadSubtitleTrack(session, "0", track.id, {
      config,
      extractEmbedded: async () => {
        extractions += 1;
        return "WEBVTT\n\n00:00.000 --> 00:01.000\nCached\n";
      },
    });
    const filename = subtitleCachePath(session.mediaContext, track.provider, track.providerId, config);
    assert.equal(first.body.includes("Cached"), true);
    assert.equal(discovery.cachePaths.has(filename), true);

    const second = await loadSubtitleTrack(session, "0", track.id, {
      config,
      extractEmbedded: async () => { throw new Error("cache was not reused"); },
    });
    assert.equal(second.body, first.body);
    assert.equal(extractions, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
