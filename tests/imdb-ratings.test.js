import assert from "node:assert/strict";
import test from "node:test";
import { POST as ratingsRoute } from "../app/api/metadata/imdb-ratings/route.js";
import { createDatabase } from "../lib/database/sqlite.js";
import { formatImdbRating } from "../lib/metadata/imdb-display.js";
import {
  getImdbRatings,
  IMDB_RATING_CACHE_TTL_MS,
  normalizeImdbRatingItems,
} from "../lib/metadata/imdb-ratings.js";
import { getOmdbRating, isOmdbConfigured } from "../lib/metadata/omdb.js";

test("formats only valid IMDb ratings", () => {
  assert.equal(formatImdbRating(8.14), "8.1");
  assert.equal(formatImdbRating("7"), "7.0");
  assert.equal(formatImdbRating("N/A"), null);
  assert.equal(formatImdbRating(11), null);
});

test("reads IMDb ratings from OMDb without exposing configuration to callers", async () => {
  let request;
  const rating = await getOmdbRating("tt1234567", {
    environment: { OMDB_API_KEY: "server-secret" },
    fetchImpl: async (url, options) => {
      request = { url: new URL(url), options };
      return new Response(JSON.stringify({ Response: "True", imdbRating: "8.3" }), { status: 200 });
    },
  });
  assert.equal(rating, 8.3);
  assert.equal(request.url.searchParams.get("i"), "tt1234567");
  assert.equal(request.url.searchParams.get("apikey"), "server-secret");
  assert.equal(request.options.cache, "no-store");
  assert.equal(isOmdbConfigured({ OMDB_API_KEY: "replace-me" }), false);
  assert.equal(isOmdbConfigured({ OMDB_API_KEY: "server-secret" }), true);
});

test("omits unavailable and invalid OMDb ratings", async () => {
  const unavailable = await getOmdbRating("tt1234567", {
    environment: { OMDB_API_KEY: "server-secret" },
    fetchImpl: async () => new Response(JSON.stringify({ Response: "False", Error: "Movie not found!" }), { status: 200 }),
  });
  const invalid = await getOmdbRating("tt1234567", {
    environment: { OMDB_API_KEY: "server-secret" },
    fetchImpl: async () => new Response(JSON.stringify({ Response: "True", imdbRating: "N/A" }), { status: 200 }),
  });
  assert.equal(unavailable, null);
  assert.equal(invalid, null);
  await assert.rejects(() => getOmdbRating("tt1234567", {
    environment: { OMDB_API_KEY: "server-secret" },
    fetchImpl: async () => new Response(JSON.stringify({ Response: "True", imdbRating: "invalid" }), { status: 200 }),
  }), (error) => error.status === 502);
});

test("validates and deduplicates a batch before provider work", () => {
  assert.deepEqual(normalizeImdbRatingItems([
    { mediaType: "movie", tmdbId: 1 },
    { mediaType: "movie", tmdbId: 1 },
    { mediaType: "tv", tmdbId: 2 },
  ]), [
    { mediaType: "movie", tmdbId: 1 },
    { mediaType: "tv", tmdbId: 2 },
  ]);
  assert.throws(() => normalizeImdbRatingItems([{ mediaType: "show", tmdbId: 1 }]), /movie or tv/);
  assert.throws(
    () => normalizeImdbRatingItems(Array.from({ length: 51 }, (_, index) => ({ mediaType: "movie", tmdbId: index + 1 }))),
    /maximum of 50/,
  );
});

test("persists ratings and serves fresh cache hits without provider calls", async () => {
  const database = createDatabase(":memory:");
  let resolved = 0;
  let fetched = 0;
  try {
    const options = {
      database,
      now: 10_000,
      omdbConfigured: true,
      resolveImdbId: async () => { resolved += 1; return "tt1234567"; },
      fetchRating: async () => { fetched += 1; return 8.1; },
    };
    const first = await getImdbRatings([{ mediaType: "movie", tmdbId: 10 }], options);
    const second = await getImdbRatings([{ mediaType: "movie", tmdbId: 10 }], options);
    assert.deepEqual(first, [{ mediaType: "movie", tmdbId: 10, imdbRating: 8.1 }]);
    assert.deepEqual(second, first);
    assert.equal(resolved, 1);
    assert.equal(fetched, 1);
    assert.equal(database.pragma("user_version", { simple: true }), 7);
  } finally {
    database.close();
  }
});

test("refreshes stale ratings by cached IMDb ID and retains stale data on failure", async () => {
  const database = createDatabase(":memory:");
  try {
    await getImdbRatings([{ mediaType: "tv", tmdbId: 20 }], {
      database,
      now: 1_000,
      omdbConfigured: true,
      resolveImdbId: async () => "tt7654321",
      fetchRating: async () => 7.4,
    });
    let resolved = false;
    const stale = await getImdbRatings([{ mediaType: "tv", tmdbId: 20 }], {
      database,
      now: 1_000 + IMDB_RATING_CACHE_TTL_MS + 1,
      omdbConfigured: true,
      resolveImdbId: async () => { resolved = true; return null; },
      fetchRating: async () => { throw new Error("provider offline"); },
    });
    assert.deepEqual(stale, [{ mediaType: "tv", tmdbId: 20, imdbRating: 7.4 }]);
    assert.equal(resolved, false);
  } finally {
    database.close();
  }
});

test("negative-caches titles without an IMDb mapping", async () => {
  const database = createDatabase(":memory:");
  let resolved = 0;
  try {
    const options = {
      database,
      now: 5_000,
      omdbConfigured: true,
      resolveImdbId: async () => { resolved += 1; return null; },
      fetchRating: async () => { throw new Error("unexpected rating lookup"); },
    };
    assert.deepEqual(await getImdbRatings([{ mediaType: "movie", tmdbId: 30 }], options), []);
    assert.deepEqual(await getImdbRatings([{ mediaType: "movie", tmdbId: 30 }], options), []);
    assert.equal(resolved, 1);
  } finally {
    database.close();
  }
});

test("limits uncached rating enrichment to four concurrent titles", async () => {
  const database = createDatabase(":memory:");
  let active = 0;
  let maximum = 0;
  try {
    const ratings = await getImdbRatings(
      Array.from({ length: 12 }, (_, index) => ({ mediaType: "movie", tmdbId: index + 1 })),
      {
        database,
        omdbConfigured: true,
        resolveImdbId: async (_mediaType, tmdbId) => {
          active += 1;
          maximum = Math.max(maximum, active);
          await new Promise((resolve) => setImmediate(resolve));
          active -= 1;
          return `tt${String(tmdbId).padStart(7, "0")}`;
        },
        fetchRating: async () => 8,
      },
    );
    assert.equal(ratings.length, 12);
    assert.equal(maximum, 4);
  } finally {
    database.close();
  }
});

test("batch route rejects malformed and oversized requests", async () => {
  const malformed = await ratingsRoute(new Request("http://localhost/api/metadata/imdb-ratings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{",
  }));
  assert.equal(malformed.status, 400);

  const oversized = await ratingsRoute(new Request("http://localhost/api/metadata/imdb-ratings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      items: Array.from({ length: 51 }, (_, index) => ({ mediaType: "tv", tmdbId: index + 1 })),
    }),
  }));
  assert.equal(oversized.status, 400);
  assert.match((await oversized.json()).error, /maximum of 50/);
});
