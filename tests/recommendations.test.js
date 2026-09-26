import assert from "node:assert/strict";
import test from "node:test";
import { createDatabase } from "../lib/database/sqlite.js";
import { listWatchedTitles } from "../lib/history/service.js";
import { filterRecommendationItems } from "../lib/metadata/catalog.js";
import { getRecommendations } from "../lib/metadata/recommendations.js";
import { createProfile } from "../lib/profiles/service.js";

function watched(database, profileId, mediaType, tmdbId, lastWatchedAt, episodeNumber = -1) {
  database.prepare(`
    INSERT INTO watch_history (
      profile_id, media_type, tmdb_id, season_number, episode_number,
      title, position_seconds, duration_seconds, completed, last_watched_at
    ) VALUES (?, ?, ?, ?, ?, ?, 20, 100, 0, ?)
  `).run(profileId, mediaType, tmdbId, mediaType === "tv" ? 1 : -1,
    episodeNumber, `${mediaType} ${tmdbId}`, lastWatchedAt);
}

function card(mediaType, id) {
  return { id, mediaType, title: `Recommended ${id}`, posterUrl: null, year: "2020" };
}

test("recommendation filters combine media type and matching TMDB genre IDs", () => {
  const items = [
    { ...card("movie", 1), genreIds: [18] },
    { ...card("tv", 2), genreIds: [80] },
    { ...card("tv", 3), genreIds: [18] },
  ];
  const genre = { slug: "drama", movieGenreId: 18, tvGenreId: 80 };
  assert.deepEqual(filterRecommendationItems(items, { genre }).map((item) => item.id), [1, 2]);
  assert.deepEqual(filterRecommendationItems(items, { type: "tv", genre }).map((item) => item.id), [2]);
  assert.deepEqual(filterRecommendationItems(items, { type: "movie" }).map((item) => item.id), [1]);
});

test("recent and all recommendations use 10 and 30 unique title seeds, with four concurrent requests", async () => {
  const database = createDatabase(":memory:");
  try {
    const profile = createProfile({ name: "Viewer" }, database);
    for (let id = 1; id <= 35; id += 1) {
      watched(database, profile.id, id % 2 ? "movie" : "tv", id, id * 1000, id % 2 ? -1 : 1);
    }
    watched(database, profile.id, "tv", 34, 34_500, 2);
    assert.equal(listWatchedTitles(profile.id, database).length, 35);

    let active = 0;
    let peak = 0;
    const calls = [];
    const fetchRecommendations = async (mediaType, id) => {
      active += 1;
      peak = Math.max(peak, active);
      calls.push(`${mediaType}:${id}`);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return [card(mediaType, id + 1000)];
    };
    const recent = await getRecommendations(profile.id, { database, now: 1000, fetchRecommendations });
    assert.equal(recent.seedCount, 10);
    assert.deepEqual(calls.slice(0, 2), ["movie:35", "tv:34"]);
    assert.ok(peak <= 4);

    calls.length = 0;
    const all = await getRecommendations(profile.id, { mode: "all", database, now: 1000, fetchRecommendations });
    assert.equal(all.seedCount, 30);
    assert.equal(calls.length, 30);
    assert.equal(new Set(calls).size, 30);
    assert.equal(all.results.length, 30);
  } finally {
    database.close();
  }
});

test("repeated recommendations rank first, duplicates merge, and watched titles disappear", async () => {
  const database = createDatabase(":memory:");
  try {
    const profile = createProfile({ name: "Viewer" }, database);
    watched(database, profile.id, "movie", 1, 3000);
    watched(database, profile.id, "tv", 2, 2000, 1);
    watched(database, profile.id, "movie", 3, 1000);
    const fetchRecommendations = async (_type, id) => id === 1
      ? [card("movie", 100), card("movie", 100), card("tv", 2), card("tv", 200)]
      : id === 2 ? [card("movie", 100), card("movie", 300)]
        : [card("movie", 300)];
    const result = await getRecommendations(profile.id, { database, fetchRecommendations });
    assert.deepEqual(result.results.map((item) => `${item.mediaType}:${item.id}`), [
      "movie:100", "movie:300", "tv:200",
    ]);
  } finally {
    database.close();
  }
});

test("partial failures return and briefly cache successes; total failures report an error", async () => {
  const database = createDatabase(":memory:");
  try {
    const profile = createProfile({ name: "Viewer" }, database);
    watched(database, profile.id, "movie", 1, 2000);
    watched(database, profile.id, "movie", 2, 1000);
    let calls = 0;
    const fetchRecommendations = async (_type, id) => {
      calls += 1;
      if (id === 1) throw new Error("upstream failed");
      return [card("movie", 100)];
    };
    const first = await getRecommendations(profile.id, { database, now: 1000, fetchRecommendations });
    assert.equal(first.partial, true);
    assert.equal(first.results.length, 1);
    await getRecommendations(profile.id, { database, now: 1000 + 14 * 60_000, fetchRecommendations });
    assert.equal(calls, 2);
    await getRecommendations(profile.id, { database, now: 1000 + 16 * 60_000, fetchRecommendations });
    assert.equal(calls, 4);

    watched(database, profile.id, "movie", 3, 3000);
    await assert.rejects(getRecommendations(profile.id, {
      database, fetchRecommendations: async () => { throw new Error("offline"); },
    }), (error) => error.status === 502 && /unavailable/.test(error.message));
    const recovered = await getRecommendations(profile.id, {
      database, fetchRecommendations: async () => [],
    });
    assert.equal(recovered.partial, false);
    assert.deepEqual(recovered.results, []);
  } finally {
    database.close();
  }
});

test("titles watched beyond the seed cap are still excluded", async () => {
  const database = createDatabase(":memory:");
  try {
    const profile = createProfile({ name: "Viewer" }, database);
    for (let id = 1; id <= 31; id += 1) watched(database, profile.id, "movie", id, id * 1000);
    const result = await getRecommendations(profile.id, {
      mode: "all", database,
      fetchRecommendations: async () => [card("movie", 1), card("movie", 100)],
    });
    assert.equal(result.seedCount, 30);
    assert.deepEqual(result.results.map((item) => item.id), [100]);
  } finally {
    database.close();
  }
});

test("final recommendations cache by watched history and remain isolated per profile", async () => {
  const database = createDatabase(":memory:");
  try {
    const first = createProfile({ name: "First" }, database);
    const second = createProfile({ name: "Second" }, database);
    watched(database, first.id, "movie", 1, 1000);
    watched(database, second.id, "movie", 1, 1000);
    let calls = 0;
    const fetchRecommendations = async () => { calls += 1; return [card("movie", 100)]; };
    await getRecommendations(first.id, { database, now: 1000, fetchRecommendations });
    await getRecommendations(first.id, { database, now: 2000, fetchRecommendations });
    assert.equal(calls, 1);
    await getRecommendations(second.id, { database, now: 2000, fetchRecommendations });
    assert.equal(calls, 2);

    watched(database, first.id, "tv", 2, 2000, 1);
    const changed = await getRecommendations(first.id, { database, now: 2000, fetchRecommendations });
    assert.equal(changed.seedCount, 2);
    assert.equal(calls, 4);

    watched(database, first.id, "movie", 100, 500);
    const excluded = await getRecommendations(first.id, { database, now: 2000, fetchRecommendations });
    assert.equal(excluded.results.length, 0);
    assert.equal(calls, 7);
    const empty = createProfile({ name: "Empty" }, database);
    assert.deepEqual(await getRecommendations(empty.id, { database, fetchRecommendations }), {
      mode: "recent", seedCount: 0, results: [], partial: false,
    });
  } finally {
    database.close();
  }
});
