import assert from "node:assert/strict";
import test from "node:test";
import { getEpisodeSegments, normalizeIntroDbSegments, normalizeSegments } from "../lib/playback/segments.js";
import { activeSkipSegment, automaticSegment, segmentPlaybackRange, showManualSkip } from "../lib/playback/segment-controls.js";
import { shouldOfferNextEpisode, shouldShowUpNext, upNextTrigger } from "../lib/playback/autoplay.js";

const EPISODE = { tmdbId: 42, season: 2, episode: 3, duration: 2700 };
const IDENTITY = { imdbId: "tt1234567", season: 2, episode: 3 };
const INTRODB_EMPTY = { imdb_id: IDENTITY.imdbId, season: 2, episode: 3,
  intro: null, recap: null, outro: null, post_credits: null };

function response(payload, ok = true) {
  return { ok, json: async () => payload };
}

test("SkipDB segments are independent and only exact or shifted ranges are used", () => {
  const segments = normalizeSegments({ segments: {
    intro: { start_ms: 20000, end_ms: 40000, match: "exact" },
    recap: { start_ms: 0, end_ms: 10000, match: "agnostic" },
    outro: { start_ms: 90000, end_ms: 100000, match: "shifted" },
    preview: { start_ms: 95000, end_ms: 120000, match: "out-of-range" },
  } }, 100);
  assert.deepEqual(segments.intro, { startMs: 20000, endMs: 40000, source: "skipdb" });
  assert.equal(segments.recap, null);
  assert.deepEqual(segments.outro, { startMs: 90000, endMs: 100000, source: "skipdb" });
  assert.equal(segments.preview, null);
  assert.equal(activeSkipSegment(25, segments).type, "intro");
  assert.equal(activeSkipSegment(40, segments), null);
  assert.equal(normalizeSegments({ segments: {
    intro: { start_ms: 100000, end_ms: 100500, match: "exact" },
  } }, 100).intro, null);
});

test("IntroDB seconds become milliseconds and invalid or mismatched ranges are ignored", () => {
  const payload = { ...INTRODB_EMPTY,
    intro: { start_sec: 2.5, end_sec: 58.25 },
    recap: { start_sec: null, end_sec: 80 },
    outro: { start_sec: 2699, end_sec: 2800 },
    post_credits: { start_sec: 2500, end_sec: 2600 },
  };
  const segments = normalizeIntroDbSegments(payload, 2700, IDENTITY);
  assert.deepEqual(segments.intro, { startMs: 2500, endMs: 58250, source: "introdb" });
  assert.equal(segments.recap, null);
  assert.equal(segments.outro, null);
  assert.equal(segments.preview, null);
  assert.equal(normalizeIntroDbSegments({ ...payload, episode: 4 }, 2700, IDENTITY).intro, null);
  assert.equal(normalizeIntroDbSegments({ ...payload, is_movie: true }, 2700, IDENTITY).intro, null);
});

test("SkipDB is first, IntroDB fills only missing types once, and merged data is cached by duration", async () => {
  const requests = [];
  const writes = [];
  const cache = new Map();
  const dependencies = {
    resolveImdbId: async () => IDENTITY.imdbId,
    readCache: (namespace, key) => cache.has(`${namespace}:${key}`)
      ? { hit: true, value: cache.get(`${namespace}:${key}`) } : { hit: false },
    writeCache: (namespace, key, value, options) => {
      writes.push({ namespace, key, options });
      cache.set(`${namespace}:${key}`, value);
    },
    fetchSegments: async (url) => {
      requests.push(url);
      return url.hostname === "api.skipdb.tv" ? response({ segments: {
        intro: { start_ms: 20000, end_ms: 40000, match: "exact" },
        recap: { start_ms: 0, end_ms: 10000, match: "agnostic" },
      } }) : response({ ...INTRODB_EMPTY,
        intro: { start_sec: 25, end_sec: 45 },
        recap: { start_sec: 0, end_sec: 10 },
        outro: { start_sec: 2600, end_sec: 2690 },
      });
    },
  };
  const result = await getEpisodeSegments(EPISODE, dependencies);
  assert.deepEqual(result.segments.intro, { startMs: 20000, endMs: 40000, source: "skipdb" });
  assert.deepEqual(result.segments.recap, { startMs: 0, endMs: 10000, source: "introdb" });
  assert.deepEqual(result.segments.outro, { startMs: 2600000, endMs: 2690000, source: "introdb" });
  assert.deepEqual(requests.map((url) => url.hostname), ["api.skipdb.tv", "api.introdb.app"]);
  assert.equal(requests[0].searchParams.get("duration"), "2700");
  assert.equal(requests[1].searchParams.get("duration"), null);
  assert.equal(writes[0].namespace, "episode-segments-v2");
  assert.equal(writes[0].options.ttlMs, 24 * 60 * 60 * 1000);
  await getEpisodeSegments(EPISODE, dependencies);
  assert.equal(requests.length, 2);
  await getEpisodeSegments({ ...EPISODE, duration: 2750 }, dependencies);
  assert.equal(requests.length, 4);
});

test("a complete SkipDB result does not request IntroDB just for a missing preview", async () => {
  const requests = [];
  const result = await getEpisodeSegments(EPISODE, {
    resolveImdbId: async () => IDENTITY.imdbId,
    readCache: () => ({ hit: false }),
    writeCache: () => {},
    fetchSegments: async (url) => {
      requests.push(url);
      return response({ segments: Object.fromEntries(["intro", "recap", "outro"].map((type, index) => [
        type, { start_ms: 10000 + index * 10000, end_ms: 20000 + index * 10000, match: "exact" },
      ])) });
    },
  });
  assert.equal(requests.length, 1);
  assert.equal(result.segments.preview, null);
});

test("provider failures retain available data but are not cached", async () => {
  const writes = [];
  const dependencies = {
    resolveImdbId: async () => IDENTITY.imdbId,
    readCache: () => ({ hit: false }),
    writeCache: (...args) => writes.push(args),
  };
  const skipDbFailed = await getEpisodeSegments(EPISODE, {
    ...dependencies,
    fetchSegments: async (url) => url.hostname === "api.skipdb.tv"
      ? response(null, false) : response({ ...INTRODB_EMPTY, intro: { start_sec: 2, end_sec: 40 } }),
  });
  assert.equal(skipDbFailed.segments.intro.source, "introdb");
  const introDbFailed = await getEpisodeSegments(EPISODE, {
    ...dependencies,
    fetchSegments: async (url) => url.hostname === "api.skipdb.tv"
      ? response({ segments: { intro: { start_ms: 2000, end_ms: 40000, match: "exact" } } })
      : Promise.reject(new Error("offline")),
  });
  assert.equal(introDbFailed.segments.intro.source, "skipdb");
  assert.equal(introDbFailed.segments.outro, null);
  const wrongEpisode = await getEpisodeSegments(EPISODE, {
    ...dependencies,
    fetchSegments: async (url) => url.hostname === "api.skipdb.tv"
      ? response({ segments: {} }) : response({ ...INTRODB_EMPTY, episode: 4,
        intro: { start_sec: 2, end_sec: 40 } }),
  });
  assert.equal(wrongEpisode.segments.intro, null);
  assert.equal(writes.length, 0);
});

test("confirmed empty results use the shorter cache lifetime and missing IMDb skips both providers", async () => {
  const writes = [];
  const dependencies = {
    resolveImdbId: async () => IDENTITY.imdbId,
    readCache: () => ({ hit: false }),
    writeCache: (_namespace, _key, _value, options) => writes.push(options),
    fetchSegments: async (url) => response(url.hostname === "api.skipdb.tv"
      ? { segments: {} } : INTRODB_EMPTY),
  };
  const empty = await getEpisodeSegments(EPISODE, dependencies);
  assert.equal(empty.segments.intro, null);
  assert.equal(writes[0].ttlMs, 60 * 60 * 1000);
  const missing = await getEpisodeSegments(EPISODE, {
    resolveImdbId: async () => null,
    fetchSegments: () => { throw new Error("should not be called"); },
  });
  assert.equal(missing.segments.outro, null);
});

test("IntroDB skips stay manual and its outro offers Up Next without an early auto transition", () => {
  const intro = { startMs: 20000, endMs: 40000, source: "introdb" };
  const outro = { startMs: 1100000, endMs: 1200000, source: "introdb" };
  const skipDbIntro = { ...intro, source: "skipdb" };
  assert.equal(automaticSegment(intro), false);
  assert.equal(automaticSegment(outro), false);
  assert.equal(automaticSegment(skipDbIntro), true);
  assert.equal(showManualSkip(intro, true), true);
  assert.equal(showManualSkip(skipDbIntro, true), false);
  assert.equal(showManualSkip(skipDbIntro, false), true);
  assert.equal(activeSkipSegment(25, { intro }).source, "introdb");
  assert.deepEqual(segmentPlaybackRange(outro), { start: 1100, end: 1200 });
  assert.equal(upNextTrigger(1200, segmentPlaybackRange(outro)), 1100);
  assert.equal(shouldShowUpNext(1100, 1200, segmentPlaybackRange(outro)), true);
  assert.equal(upNextTrigger(1200), 1170);
  assert.equal(shouldShowUpNext(1169, 1200), false);
  assert.equal(shouldOfferNextEpisode(1080, 1200, segmentPlaybackRange(outro)), true);
});
