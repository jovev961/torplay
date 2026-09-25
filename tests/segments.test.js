import assert from "node:assert/strict";
import test from "node:test";
import { getEpisodeSegments, normalizeSegments } from "../lib/playback/segments.js";
import { activeSkipSegment } from "../lib/playback/segment-controls.js";
import { shouldOfferNextEpisode, shouldShowUpNext, upNextTrigger } from "../lib/playback/autoplay.js";

test("segment types are independent and uncertain or invalid ranges are ignored", () => {
  const segments = normalizeSegments({ segments: {
    intro: { start_ms: 20000, end_ms: 40000, match: "exact" },
    recap: { start_ms: 0, end_ms: 10000, match: "agnostic" },
    outro: { start_ms: 90000, end_ms: 100000, match: "shifted" },
    preview: { start_ms: 95000, end_ms: 120000, match: "exact" },
  } }, 100);
  assert.deepEqual(segments.intro, { start: 20, end: 40 });
  assert.equal(segments.recap, null);
  assert.deepEqual(segments.outro, { start: 90, end: 100 });
  assert.equal(segments.preview, null);
  assert.equal(activeSkipSegment(25, segments).type, "intro");
  assert.equal(activeSkipSegment(40, segments), null);
  assert.equal(normalizeSegments({ segments: {
    intro: { start_ms: 100000, end_ms: 100500, match: "exact" },
  } }, 100).intro, null);
});

test("episode segments request actual duration and use a duration-specific cache", async () => {
  const requests = [];
  const cache = new Map();
  const dependencies = {
    resolveImdbId: async () => "tt1234567",
    readCache: (_namespace, key) => cache.has(key) ? { hit: true, value: cache.get(key) } : { hit: false },
    writeCache: (_namespace, key, value) => cache.set(key, value),
    fetchSegments: async (url) => {
      requests.push(url);
      return { ok: true, json: async () => ({ segments: {
        intro: { start_ms: 10000, end_ms: 30000, match: "exact" },
      } }) };
    },
  };
  const episode = { tmdbId: 42, season: 2, episode: 3, duration: 2700 };
  assert.deepEqual((await getEpisodeSegments(episode, dependencies)).segments.intro, { start: 10, end: 30 });
  await getEpisodeSegments(episode, dependencies);
  await getEpisodeSegments({ ...episode, duration: 2750 }, dependencies);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].searchParams.get("duration"), "2700");
  assert.equal(requests[0].searchParams.get("imdb_id"), "tt1234567");
  assert.equal(requests[0].searchParams.get("season"), "2");
});

test("missing or failed SkipDB data never blocks playback", async () => {
  const episode = { tmdbId: 42, season: 1, episode: 1, duration: 1800 };
  const missing = await getEpisodeSegments(episode, { resolveImdbId: async () => null });
  const failed = await getEpisodeSegments(episode, {
    resolveImdbId: async () => "tt1234567",
    readCache: () => ({ hit: false }),
    fetchSegments: async () => { throw new Error("offline"); },
  });
  assert.equal(missing.segments.intro, null);
  assert.equal(failed.segments.outro, null);
});

test("outro starts Up Next and missing outro waits for the final 30 seconds", () => {
  assert.equal(upNextTrigger(1200, { start: 1100, end: 1200 }), 1100);
  assert.equal(shouldShowUpNext(1099, 1200, { start: 1100, end: 1200 }), false);
  assert.equal(shouldShowUpNext(1100, 1200, { start: 1100, end: 1200 }), true);
  assert.equal(upNextTrigger(1200), 1170);
  assert.equal(shouldShowUpNext(1169, 1200), false);
  assert.equal(shouldShowUpNext(1170, 1200), true);
  assert.equal(shouldOfferNextEpisode(1079, 1200), false);
  assert.equal(shouldOfferNextEpisode(1080, 1200), true);
});
