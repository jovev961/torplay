import assert from "node:assert/strict";
import test from "node:test";
import { searchKnaben } from "../lib/search/native/knaben.js";
import { searchYts } from "../lib/search/native/yts.js";
import { searchEztv } from "../lib/search/native/eztv.js";
import { configuredProviders } from "../lib/search/provider.js";
import { findAuthorizedSources } from "../lib/search/service.js";
import { startNativeDevelopment } from "../scripts/dev-native.js";

const hash = "a".repeat(40);
const movie = { title: "Sintel", type: "movie", imdbId: "tt1727587", year: 2010 };
const show = { title: "Example", type: "show", imdbId: "tt123", season: 2, episode: 3 };
const fixtures = {
  knaben: { hits: [{ title: "Sintel 2010", bytes: 1000, seeders: 3, hash, tracker: "Example" }] },
  yts: { status: "ok", data: { movie_count: 1, movies: [{ title: "Sintel", year: 2010, imdb_code: movie.imdbId,
    torrents: [{ hash, quality: "1080p", type: "bluray", video_codec: "x264", size_bytes: 1000, seeds: 5, peers: 2 }] }] } },
  eztv: { torrents_count: 1, torrents: [{ title: "Example S02E03", imdb_id: "123", season: "2", episode: "3",
    hash: "b".repeat(40), seeds: 3, size_bytes: "1000", magnet_url: `magnet:?xt=urn:btih:${"b".repeat(40)}` }] },
};
async function mockFetch(implementation, run) {
  const previous = globalThis.fetch;
  globalThis.fetch = implementation;
  try { await run(); } finally { globalThis.fetch = previous; }
}
const response = (data) => Response.json(data);

test("native adapters build documented requests and map metadata", async () => {
  await mockFetch(async (url, options) => {
    assert.equal(options.signal instanceof AbortSignal, true);
    const address = new URL(url);
    if (address.hostname === "api.knaben.org") {
      assert.equal(address.pathname, "/v1");
      assert.equal(JSON.parse(options.body).query, movie.title);
      return response(fixtures.knaben);
    }
    if (address.pathname.endsWith("list_movies.json")) {
      assert.equal(address.searchParams.get("query_term"), movie.imdbId);
      return response(fixtures.yts);
    }
    assert.equal(address.searchParams.get("imdb_id"), "123");
    return response(fixtures.eztv);
  }, async () => {
    const options = { signal: new AbortController().signal };
    assert.equal((await searchKnaben(movie, options))[0].indexer, "Example");
    assert.equal((await searchYts(movie, options))[0].resolution, "1080p");
    assert.equal((await searchEztv(show, options))[0].media.episode, 3);
  });
});

test("Knaben searches episode and season variants; unsupported providers make no requests", async () => {
  const queries = [];
  await mockFetch(async (_, options) => { queries.push(JSON.parse(options.body).query); return response({ hits: [] }); }, async () => {
    await searchKnaben(show);
    assert.deepEqual(queries, ["Example S02E03", "Example S02"]);
    assert.deepEqual(await searchYts(show), []);
    assert.deepEqual(await searchEztv(movie), []);
    assert.deepEqual(await searchEztv({ ...show, imdbId: null }), []);
    assert.equal(queries.length, 2);
  });
});

test("EZTV paginates and filters wrong episodes and identities", async () => {
  const pages = [];
  await mockFetch(async (url) => {
    const page = Number(new URL(url).searchParams.get("page"));
    pages.push(page);
    return response({ torrents_count: 101, torrents: page === 1
      ? Array.from({ length: 100 }, () => ({ ...fixtures.eztv.torrents[0], episode: 4 }))
      : fixtures.eztv.torrents });
  }, async () => {
    assert.equal((await searchEztv(show)).length, 1);
    assert.deepEqual(pages, [1, 2]);
  });
});

test("adapters reject malformed and HTTP failures and honor cancellation", async () => {
  for (const [search, context] of [[searchKnaben, movie], [searchYts, movie], [searchEztv, show]]) {
    await mockFetch(async () => response({}), async () => assert.rejects(search(context)));
    await mockFetch(async () => new Response("", { status: 503 }), async () => assert.rejects(search(context)));
    const signal = AbortSignal.abort();
    await mockFetch(async (_, options) => { options.signal.throwIfAborted(); }, async () => assert.rejects(search(context, { signal })));
  }
});

test("empty responses succeed, YTS expands variants, and EZTV stops at ten pages", async () => {
  for (const [search, context, data] of [
    [searchKnaben, movie, { hits: [] }],
    [searchYts, movie, { status: "ok", data: { movie_count: 0 } }],
    [searchEztv, show, { torrents_count: 0 }],
  ]) {
    await mockFetch(async () => response(data), async () => assert.deepEqual(await search(context), []));
  }
  const data = structuredClone(fixtures.yts);
  data.data.movies[0].torrents.push({ ...data.data.movies[0].torrents[0], quality: "720p" });
  await mockFetch(async () => response(data), async () => assert.equal((await searchYts(movie)).length, 2));
  let pages = 0;
  await mockFetch(async () => {
    pages += 1;
    return response({ torrents_count: 2000, torrents: Array.from({ length: 100 }, () => fixtures.eztv.torrents[0]) });
  }, async () => {
    await searchEztv(show);
    assert.equal(pages, 10);
  });
});

test("native-only movie and TV discovery never contacts Jackett", async () => {
  const providers = configuredProviders({ TORPLAY_SEARCH_PROVIDERS: "knaben,yts,eztv", JACKETT_API_KEY: "secret", JACKETT_URL: "http://localhost:9117" });
  assert.deepEqual(providers.map((item) => item.id), ["knaben", "yts", "eztv"]);
  assert.throws(() => configuredProviders({ TORPLAY_SEARCH_PROVIDERS: "unknown" }), /Unknown/);
  await mockFetch(async (url) => {
    const host = new URL(url).hostname;
    assert.notEqual(host, "localhost");
    return response(host === "api.knaben.org" ? fixtures.knaben : host === "eztvx.to" ? fixtures.eztv : fixtures.yts);
  }, async () => {
    for (const context of [movie, show]) {
      const results = await findAuthorizedSources(context, { providers });
      assert.ok(results.length > 0);
      assert.equal(JSON.stringify(results).includes("magnet:"), false);
    }
  });
});

test("native development launches Next only and overrides an inherited provider selection", () => {
  const calls = [];
  startNativeDevelopment({ environment: { TORPLAY_SEARCH_PROVIDERS: "jackett" }, spawnProcess: (...args) => calls.push(args) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1][1], "dev");
  assert.equal(calls[0][2].env.TORPLAY_SEARCH_PROVIDERS, "knaben,yts,eztv");
});
