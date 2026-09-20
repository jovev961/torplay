import assert from "node:assert/strict";
import test from "node:test";
import { createDatabase } from "../lib/database/sqlite.js";
import {
  discoverCatalog,
  getGenreDefinitions,
  getImdbId,
  getMovieDetails,
  getSeasonDetails,
  getShowDetails,
  getTrending,
  searchCatalog,
  searchMetadata,
  TMDB_METADATA_CACHE_TTL_MS,
  tmdbImage,
} from "../lib/metadata/tmdb.js";

async function withTmdb(run) {
  const previousToken = process.env.TMDB_API_TOKEN;
  process.env.TMDB_API_TOKEN = "tmdb-secret";
  try {
    return await run();
  } finally {
    if (previousToken === undefined) delete process.env.TMDB_API_TOKEN;
    else process.env.TMDB_API_TOKEN = previousToken;
  }
}

test("builds TMDB image URLs and rejects invalid paths", () => {
  assert.equal(tmdbImage("/poster.jpg", "w500"), "https://image.tmdb.org/t/p/w500/poster.jpg");
  assert.equal(tmdbImage("https://example.test/image.jpg", "w500"), null);
});

test("uses a server-side bearer token and normalizes separate media types", async () => {
  await withTmdb(async () => {
    const previousFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (url, options) => {
      requests.push({ url: new URL(url), options });
      return new Response(JSON.stringify({
        results: [{ id: 10, title: "Sintel", release_date: "2010-05-21", poster_path: "/sintel.jpg", vote_average: 7.2 }],
      }), { status: 200 });
    };

    try {
      const results = await getTrending("movie");
      assert.equal(requests[0].url.pathname, "/3/trending/movie/week");
      assert.equal(requests[0].options.headers.Authorization, "Bearer tmdb-secret");
      assert.equal(results[0].mediaType, "movie");
      assert.equal(results[0].year, "2010");
      assert.equal(JSON.stringify(results).includes("tmdb-secret"), false);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("searches movies and TV by default and interleaves normalized pages", async () => {
  await withTmdb(async () => {
    const previousFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (url) => {
      const parsed = new URL(url);
      requests.push(parsed);
      const movie = parsed.pathname.endsWith("/search/movie");
      return new Response(JSON.stringify({
        page: 2,
        total_pages: movie ? 5 : 3,
        total_results: movie ? 90 : 40,
        results: movie
          ? [{ id: 1, title: "Alien", original_title: "Alien", genre_ids: [27], popularity: 20 }]
          : [{ id: 2, name: "Alien: Earth", original_name: "Alien: Earth", genre_ids: [18], popularity: 10 }],
      }), { status: 200 });
    };
    try {
      const result = await searchCatalog({ query: "alien", page: 2 });
      assert.deepEqual(requests.map((url) => url.pathname).sort(), ["/3/search/movie", "/3/search/tv"]);
      assert.ok(requests.every((url) => url.searchParams.get("page") === "2"));
      assert.deepEqual(result.results.map((item) => item.mediaType), ["movie", "tv"]);
      assert.equal(result.totalPages, 5);
      assert.equal(result.totalResults, 130);
      assert.equal(result.hasPreviousPage, true);
      assert.equal(result.hasNextPage, true);
      assert.equal(result.totalsExact, true);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("maps separate movie and TV genre IDs and filters a search page", async () => {
  await withTmdb(async () => {
    const previousFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (url) => {
      const parsed = new URL(url);
      requests.push(parsed);
      if (parsed.pathname.endsWith("/genre/movie/list")) {
        return new Response(JSON.stringify({ genres: [{ id: 27, name: "Horror" }] }), { status: 200 });
      }
      if (parsed.pathname.endsWith("/genre/tv/list")) {
        return new Response(JSON.stringify({ genres: [{ id: 80, name: "Horror" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({
        page: 1,
        total_pages: 2,
        total_results: 2,
        results: [
          { id: 1, title: "Keep", genre_ids: [27] },
          { id: 2, title: "Remove", genre_ids: [18] },
        ],
      }), { status: 200 });
    };
    try {
      const genres = await getGenreDefinitions("all");
      assert.deepEqual(genres[0], {
        slug: "horror",
        name: "Horror",
        movieGenreId: 27,
        tvGenreId: 80,
        supportedMediaTypes: ["movie", "tv"],
      });
      requests.length = 0;
      const result = await searchCatalog({ query: "test", type: "movie", genre: "horror" });
      assert.equal(result.results.length, 1);
      assert.equal(result.results[0].title, "Keep");
      assert.equal(result.totalsExact, false);
      assert.equal(requests.find((url) => url.pathname.endsWith("/search/movie")).searchParams.has("with_genres"), false);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("discovers TV with the TV genre ID and provider pagination", async () => {
  await withTmdb(async () => {
    const previousFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (url, options) => {
      const parsed = new URL(url);
      requests.push({ url: parsed, options });
      if (parsed.pathname.endsWith("/genre/movie/list")) {
        return new Response(JSON.stringify({ genres: [{ id: 35, name: "Comedy" }] }), { status: 200 });
      }
      if (parsed.pathname.endsWith("/genre/tv/list")) {
        return new Response(JSON.stringify({ genres: [{ id: 10767, name: "Comedy" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({
        page: 3,
        total_pages: 8,
        total_results: 150,
        results: [{ id: 9, name: "Comedy Show", genre_ids: [10767] }],
      }), { status: 200 });
    };
    try {
      const result = await discoverCatalog({ type: "tv", genre: "comedy", page: 3 });
      const discoverRequest = requests.find(({ url }) => url.pathname.endsWith("/discover/tv"));
      assert.equal(discoverRequest.url.searchParams.get("with_genres"), "10767");
      assert.equal(discoverRequest.url.searchParams.get("page"), "3");
      assert.equal(discoverRequest.options.next.revalidate, 900);
      assert.equal(result.results[0].mediaType, "tv");
      assert.equal(result.totalPages, 8);
      assert.equal(result.totalsExact, true);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("returns an empty successful search without calling TMDB", async () => {
  const previousFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    throw new Error("unexpected fetch");
  };
  try {
    const result = await searchCatalog({ query: "", type: "all" });
    assert.deepEqual(result.results, []);
    assert.equal(result.totalResults, 0);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("validates catalog filters and propagates provider errors", async () => {
  await assert.rejects(() => searchCatalog({ query: "x", type: "person" }), (error) => error.status === 400);
  await assert.rejects(() => discoverCatalog({ page: 501 }), (error) => error.status === 400);
  await withTmdb(async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("{}", { status: 503 });
    try {
      await assert.rejects(() => searchCatalog({ query: "alien", type: "movie" }), (error) => error.status === 502);
      await assert.rejects(() => discoverCatalog({ type: "movie" }), (error) => error.status === 502);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("searches movies and shows through distinct TMDB endpoints", async () => {
  await withTmdb(async () => {
    const previousFetch = globalThis.fetch;
    const paths = [];
    globalThis.fetch = async (url) => {
      paths.push(new URL(url));
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    };
    try {
      await searchMetadata("movie", "Sintel");
      await searchMetadata("show", "Example");
      assert.equal(paths[0].pathname, "/3/search/movie");
      assert.equal(paths[0].searchParams.get("include_adult"), "false");
      assert.equal(paths[1].pathname, "/3/search/tv");
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("normalizes movie, show, season, and episode details", async () => {
  await withTmdb(async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/movie/1")) {
        return new Response(JSON.stringify({ id: 1, title: "Movie", genres: [{ name: "Drama" }], runtime: 90 }));
      }
      if (path.endsWith("/tv/2")) {
        return new Response(JSON.stringify({ id: 2, name: "Show", genres: [], seasons: [{ season_number: 1, episode_count: 2, name: "Season 1" }] }));
      }
      return new Response(JSON.stringify({ season_number: 1, name: "Season 1", episodes: [{ episode_number: 2, name: "Episode", still_path: "/still.jpg" }] }));
    };
    try {
      assert.equal((await getMovieDetails(1)).runtime, 90);
      assert.equal((await getShowDetails(2)).seasons[0].number, 1);
      assert.equal((await getSeasonDetails(2, 1)).episodes[0].stillUrl, "https://image.tmdb.org/t/p/w500/still.jpg");
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("resolves a precise IMDb ID through TMDB external IDs", async () => {
  await withTmdb(async () => {
    const previousFetch = globalThis.fetch;
    let request;
    globalThis.fetch = async (url, options) => {
      request = { url: new URL(url), options };
      return new Response(JSON.stringify({ imdb_id: "tt1234567" }), { status: 200 });
    };
    try {
      assert.equal(await getImdbId("tv", 42), "tt1234567");
      assert.equal(request.url.pathname, "/3/tv/42/external_ids");
      assert.equal(request.options.next.revalidate, 2592000);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("reports missing TMDB configuration without leaking credentials", async () => {
  const previousToken = process.env.TMDB_API_TOKEN;
  delete process.env.TMDB_API_TOKEN;
  try {
    await assert.rejects(() => getTrending("movie"), (error) => error.status === 500);
  } finally {
    if (previousToken === undefined) delete process.env.TMDB_API_TOKEN;
    else process.env.TMDB_API_TOKEN = previousToken;
  }
});

test("rejects a v3 API key placed in the bearer-token setting", async () => {
  const previousToken = process.env.TMDB_API_TOKEN;
  process.env.TMDB_API_TOKEN = "0123456789abcdef0123456789abcdef";
  try {
    await assert.rejects(
      () => getTrending("movie"),
      (error) => error.status === 500 && error.message.includes("API Read Access Token"),
    );
  } finally {
    if (previousToken === undefined) delete process.env.TMDB_API_TOKEN;
    else process.env.TMDB_API_TOKEN = previousToken;
  }
});

test("persists public TMDB metadata without caching its bearer token", async () => {
  await withTmdb(async () => {
    const database = createDatabase(":memory:");
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return new Response(JSON.stringify({ id: 77, title: "Cached Movie", runtime: 90 }), { status: 200 });
    };
    try {
      const options = { fetchImpl, usePersistentCache: true, cacheDatabase: database, now: 1_000 };
      assert.equal((await getMovieDetails(77, options)).title, "Cached Movie");
      assert.equal((await getMovieDetails(77, { ...options, now: 2_000 })).title, "Cached Movie");
      assert.equal(calls, 1);
      const row = database.prepare("SELECT cache_key, value_json FROM external_response_cache WHERE namespace = 'tmdb'").get();
      assert.equal(`${row.cache_key}${row.value_json}`.includes("tmdb-secret"), false);
      await getMovieDetails(77, { ...options, now: 1_000 + TMDB_METADATA_CACHE_TTL_MS + 1 });
      assert.equal(calls, 2);
    } finally {
      database.close();
    }
  });
});
