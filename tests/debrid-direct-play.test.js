import assert from "node:assert/strict";
import test from "node:test";
import { createDatabase } from "../lib/database/sqlite.js";
import { associateDebridItem, mapDebridEpisodeFile, rememberReadyResource,
  resolveDirectDebridPlayback, inspectDirectDebridAvailability,
  listReadyDebridEpisodes } from "../lib/debrid/library.js";
import { findPlaybackSessionEpisode, getPlaybackMediaContext, stopPlayback } from "../lib/debrid/session.js";
import { readyEpisodesForSeason } from "../lib/video/ready-episodes.js";

const hash = "e".repeat(40);
const show = { type: "show", tmdbId: 101, season: 1, episode: 1 };
const baseConfig = { mode: "prefer-debrid", priority: ["real-debrid", "torbox"],
  credentials: { "real-debrid": { apiKey: "private" } } };

function readyProvider({ id = "rd-pack", provider = "real-debrid", missing = false, infoHash = hash,
  filenames = ["Example.S01E01.mkv", "Example.S01E02.mkv"] } = {}) {
  const calls = { resources: 0, streams: [], submissions: 0, lists: 0 };
  const raw = provider === "real-debrid"
    ? { id, hash: infoHash, status: "downloaded", filename: "Example pack",
      links: filenames.map((_, index) => `https://host.example/${index + 1}`),
      files: filenames.map((name, index) => ({ id: index + 1, path: `/${name}`, bytes: 1000, selected: 1 })) }
    : { id: Number(id), hash: infoHash, name: "Example pack", download_present: true, download_finished: true,
      files: filenames.map((name, index) => ({ id: index + 1, name, size: 1000 })) };
  return { calls,
    async getAccountInfo() { return { id: provider === "real-debrid" ? 1 : 2 }; },
    async getResource() {
      calls.resources += 1;
      if (missing) throw Object.assign(new Error("Missing"), { upstreamStatus: 404, code: "provider-error" });
      return structuredClone(raw);
    },
    async resolveStream(_torrent, file) {
      calls.streams.push(file.providerId);
      return { url: `https://cdn.example/${file.providerId}`, resource: { id, owned: false } };
    },
    async submit() { calls.submissions += 1; throw new Error("Unexpected submission"); },
    async listResources() { calls.lists += 1; throw new Error("Unexpected account scan"); },
  };
}

function dependencies(db, providers, config = baseConfig) {
  return { database: db, config, providerFactory: (id) => providers[id], probe: async () => {},
    getShowDetails: async () => ({ title: "Example", seasons: [{ number: 1 }], year: "2020" }),
    getMovieDetails: async () => ({ title: "Example Film", year: "2020" }),
    getSeasonDetails: async () => ({ episodes: [
      { number: 1, title: "First Story" }, { number: 2, title: "Second Story" },
    ] }),
  };
}

test("ready season-pack episodes play different files from one resource without a provider scan", async () => {
  const db = createDatabase(":memory:");
  const rd = readyProvider();
  const deps = dependencies(db, { "real-debrid": rd });
  try {
    await associateDebridItem("real-debrid", "rd-pack", show, deps);
    const first = await resolveDirectDebridPlayback(show, deps);
    const second = await resolveDirectDebridPlayback({ ...show, episode: 2 }, deps);
    assert.equal(first.kind, "hit");
    assert.equal(second.kind, "hit");
    assert.notEqual(first.fileId, second.fileId);
    assert.equal(findPlaybackSessionEpisode(first.session.id, 1, 2)?.file.id, second.fileId);
    assert.equal(getPlaybackMediaContext(second.session.id).episode, 2);
    assert.deepEqual(rd.calls.streams, ["1", "2"]);
    assert.equal(rd.calls.submissions, 0);
    assert.equal(rd.calls.lists, 0);
    await stopPlayback(first.session.id);
    await stopPlayback(second.session.id);
  } finally { db.close(); }
});

test("TMDB episode-list mapping reaches the same direct-play path", async () => {
  const db = createDatabase(":memory:");
  const rd = readyProvider({ filenames: ["The First Story.mkv", "The Second Story.mkv"] });
  const deps = dependencies(db, { "real-debrid": rd });
  try {
    await associateDebridItem("real-debrid", "rd-pack", show, deps);
    assert.equal(db.prepare("SELECT count(*) AS count FROM episode_file_mappings").get().count, 2);
    const result = await resolveDirectDebridPlayback({ ...show, episode: 2 }, deps);
    assert.equal(result.kind, "hit");
    assert.deepEqual(rd.calls.streams, ["2"]);
    await stopPlayback(result.session.id);
  } finally { db.close(); }
});

test("ambiguous filenames do not start the wrong episode", async () => {
  const db = createDatabase(":memory:");
  const rd = readyProvider({ filenames: ["Example.S01E02.mkv", "Example.S01E02.copy.mkv"] });
  const deps = dependencies(db, { "real-debrid": rd });
  try {
    await associateDebridItem("real-debrid", "rd-pack", show, deps);
    assert.deepEqual(await resolveDirectDebridPlayback({ ...show, episode: 2 }, deps), { kind: "miss" });
    assert.deepEqual(rd.calls.streams, []);
  } finally { db.close(); }
});

test("an external pack can be manually corrected and its choice survives refresh", async () => {
  const db = createDatabase(":memory:");
  const rd = readyProvider({ filenames: ["OP-1.mkv", "OP-2.mkv"] });
  const deps = dependencies(db, { "real-debrid": rd });
  try {
    await associateDebridItem("real-debrid", "rd-pack", show, deps);
    assert.deepEqual(await resolveDirectDebridPlayback({ ...show, episode: 2 }, deps), { kind: "miss" });
    const corrected = await mapDebridEpisodeFile("real-debrid", "rd-pack", "2", 1, 2, deps);
    assert.equal(corrected.episodeMappings[0].source, "manual");
    const result = await resolveDirectDebridPlayback({ ...show, episode: 2 }, deps);
    assert.equal(result.kind, "hit");
    assert.deepEqual(rd.calls.streams, ["2"]);
    await stopPlayback(result.session.id);
  } finally { db.close(); }
});

test("changing a mapping removes the old episode and requires confirmation to replace another file", async () => {
  const db = createDatabase(":memory:");
  const rd = readyProvider();
  const deps = dependencies(db, { "real-debrid": rd });
  try {
    await associateDebridItem("real-debrid", "rd-pack", show, deps);
    const changed = await mapDebridEpisodeFile("real-debrid", "rd-pack", "1", 1, 3, deps,
      { replaceExisting: true });
    assert.deepEqual(changed.episodeMappings.map(({ fileId, episode }) => [fileId, episode]),
      [["2", 2], ["1", 3]]);
    assert.deepEqual(await resolveDirectDebridPlayback(show, deps), { kind: "miss" });
    await assert.rejects(mapDebridEpisodeFile("real-debrid", "rd-pack", "1", 1, 2, deps,
      { replaceExisting: true }), { status: 409 });
    await assert.rejects(mapDebridEpisodeFile("real-debrid", "rd-pack", "1", 1, 2, deps,
      { replaceExisting: true, expectedTargetFileId: "3" }), { status: 409 });
    const replaced = await mapDebridEpisodeFile("real-debrid", "rd-pack", "1", 1, 2, deps,
      { replaceExisting: true, expectedTargetFileId: "2" });
    assert.deepEqual(replaced.episodeMappings.map(({ fileId, episode }) => [fileId, episode]),
      [["1", 2]]);
    const playback = await resolveDirectDebridPlayback({ ...show, episode: 2 }, deps);
    assert.equal(playback.kind, "hit");
    assert.deepEqual(rd.calls.streams, ["1"]);
    await stopPlayback(playback.session.id);
  } finally { db.close(); }
});

test("ready movie and preferred TorBox resource play directly", async () => {
  const db = createDatabase(":memory:");
  const rd = readyProvider();
  const tb = readyProvider({ id: "42", provider: "torbox" });
  const config = { ...baseConfig, priority: ["torbox", "real-debrid"],
    credentials: { ...baseConfig.credentials, torbox: { apiKey: "other-private" } } };
  const deps = dependencies(db, { "real-debrid": rd, torbox: tb }, config);
  try {
    await associateDebridItem("real-debrid", "rd-pack", show, deps);
    await associateDebridItem("torbox", "42", show, deps);
    const preferred = await resolveDirectDebridPlayback(show, deps);
    assert.equal(preferred.session.provider, "torbox");
    await stopPlayback(preferred.session.id);
    const movie = { type: "movie", tmdbId: 202 };
    await associateDebridItem("real-debrid", "rd-pack", movie, deps);
    const played = await resolveDirectDebridPlayback(movie, deps);
    assert.equal(played.kind, "hit");
    assert.equal(played.session.provider, "real-debrid");
    await stopPlayback(played.session.id);
  } finally { db.close(); }
});

test("ready library discovery lists both providers without opening playback", async () => {
  const db = createDatabase(":memory:");
  const rd = readyProvider();
  const tb = readyProvider({ id: "42", provider: "torbox" });
  const config = { ...baseConfig, credentials: { ...baseConfig.credentials, torbox: { apiKey: "other-private" } } };
  const deps = dependencies(db, { "real-debrid": rd, torbox: tb }, config);
  try {
    await associateDebridItem("real-debrid", "rd-pack", show, deps);
    await associateDebridItem("torbox", "42", show, deps);
    const ready = await inspectDirectDebridAvailability(show, deps);
    assert.deepEqual(ready.sources.map((source) => source.provider), ["real-debrid", "torbox"]);
    assert.deepEqual(rd.calls.streams, []);
    assert.deepEqual(tb.calls.streams, []);
    const selected = await resolveDirectDebridPlayback(show,
      { ...deps, selection: { provider: "torbox", resourceId: "42" } });
    assert.equal(selected.session.provider, "torbox");
    assert.deepEqual(rd.calls.streams, []);
    assert.deepEqual(tb.calls.streams, ["1"]);
    await stopPlayback(selected.session.id);
  } finally { db.close(); }
});

test("an automatically learned movie requires matching release-year evidence", async () => {
  const db = createDatabase(":memory:");
  const rd = readyProvider();
  const deps = dependencies(db, { "real-debrid": rd });
  const context = { type: "movie", tmdbId: 202, title: "Example Film", year: 2020 };
  try {
    await rememberReadyResource("real-debrid", rd, hash, "rd-pack",
      { releaseName: "Example Film 1999", mediaContext: context }, deps);
    assert.deepEqual(await resolveDirectDebridPlayback(context, deps), { kind: "miss" });
    await rememberReadyResource("real-debrid", rd, hash, "rd-pack",
      { releaseName: "Example Film 2020", mediaContext: context }, deps);
    const result = await resolveDirectDebridPlayback(context, deps);
    assert.equal(result.kind, "hit");
    await stopPlayback(result.session.id);
  } finally { db.close(); }
});

test("deleted preferred resource falls through to the other provider and removes stale index", async () => {
  const db = createDatabase(":memory:");
  const rd = readyProvider({ missing: true });
  const tb = readyProvider({ id: "42", provider: "torbox" });
  const config = { ...baseConfig, credentials: { ...baseConfig.credentials, torbox: { apiKey: "other-private" } } };
  const deps = dependencies(db, { "real-debrid": rd, torbox: tb }, config);
  try {
    const healthyRd = readyProvider();
    await associateDebridItem("real-debrid", "rd-pack", show,
      dependencies(db, { "real-debrid": healthyRd, torbox: tb }, config));
    await associateDebridItem("torbox", "42", show, deps);
    const result = await resolveDirectDebridPlayback(show, deps);
    assert.equal(result.session.provider, "torbox");
    assert.equal(db.prepare("SELECT count(*) AS count FROM debrid_media_links WHERE provider = 'real-debrid'").get().count, 0);
    await stopPlayback(result.session.id);
    assert.deepEqual(await resolveDirectDebridPlayback({ ...show, tmdbId: 999 }, deps), { kind: "miss" });
  } finally { db.close(); }
});

test("ready episode index filters seasons numerically without new provider reads on season switches", async () => {
  const db = createDatabase(":memory:");
  const rd = readyProvider({ filenames: [
    "Example.S01E10.mkv", "Example.S02E03.mkv", "Example.S01E02.mkv",
    "Example.S01E01.mkv", "Example.S01E11.mkv", "Example.S01E03.mkv",
    "Example.S02E01.mkv", "Unknown.mkv",
  ] });
  const deps = dependencies(db, { "real-debrid": rd });
  try {
    await associateDebridItem("real-debrid", "rd-pack", show, deps);
    const indexed = await listReadyDebridEpisodes(show.tmdbId, deps);
    assert.equal(indexed.temporarilyUnavailable, false);
    assert.deepEqual(readyEpisodesForSeason(indexed.episodes, 1).map((entry) => entry.episode),
      [1, 2, 3, 10, 11]);
    assert.deepEqual(readyEpisodesForSeason(indexed.episodes, 2).map((entry) => entry.episode), [1, 3]);
    assert.deepEqual(readyEpisodesForSeason(indexed.episodes, 3), []);
    assert.equal(indexed.episodes.length, 7);
    const resourceReads = rd.calls.resources;
    readyEpisodesForSeason(indexed.episodes, 1);
    readyEpisodesForSeason(indexed.episodes, 2);
    assert.equal(rd.calls.resources, resourceReads);
    await listReadyDebridEpisodes(show.tmdbId, deps);
    assert.equal(rd.calls.resources, resourceReads);
    assert.equal(rd.calls.lists, 0);
  } finally { db.close(); }
});

test("ready episode index honors preferred provider and includes manual and metadata mappings", async () => {
  const db = createDatabase(":memory:");
  const rd = readyProvider({ filenames: ["The First Story.mkv", "OP-2.mkv"] });
  const tb = readyProvider({ id: "42", provider: "torbox", infoHash: "f".repeat(40) });
  const config = { ...baseConfig, priority: ["torbox", "real-debrid"],
    credentials: { ...baseConfig.credentials, torbox: { apiKey: "other-private" } } };
  const deps = dependencies(db, { "real-debrid": rd, torbox: tb }, config);
  try {
    await associateDebridItem("real-debrid", "rd-pack", show, deps);
    await mapDebridEpisodeFile("real-debrid", "rd-pack", "2", 1, 2, deps);
    await associateDebridItem("torbox", "42", show, deps);
    const indexed = await listReadyDebridEpisodes(show.tmdbId, deps);
    assert.deepEqual(indexed.episodes.map((entry) => [entry.episode, entry.provider]),
      [[1, "torbox"], [2, "torbox"]]);
    assert.equal(db.prepare("SELECT source FROM episode_file_mappings WHERE info_hash = ? AND tmdb_id = ? AND season_number = 1 AND episode_number = 2")
      .get(hash, show.tmdbId).source, "manual");
  } finally { db.close(); }
});

test("ready episode index respects provider cooldown after HTTP 429", async () => {
  const db = createDatabase(":memory:");
  const rd = readyProvider();
  const deps = dependencies(db, { "real-debrid": rd });
  try {
    await associateDebridItem("real-debrid", "rd-pack", show, deps);
    rd.getResource = async () => {
      rd.calls.resources += 1;
      throw Object.assign(new Error("Rate limited"), {
        code: "rate-limited", upstreamStatus: 429, retryAfter: "30",
      });
    };
    assert.equal((await listReadyDebridEpisodes(show.tmdbId, deps)).temporarilyUnavailable, true);
    const reads = rd.calls.resources;
    assert.equal((await listReadyDebridEpisodes(show.tmdbId, deps)).temporarilyUnavailable, true);
    assert.equal(rd.calls.resources, reads);
  } finally { db.close(); }
});
