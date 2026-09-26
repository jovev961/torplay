import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { searchEztv } from "../lib/search/native/eztv.js";
import { searchKnaben } from "../lib/search/native/knaben.js";
import { searchYts } from "../lib/search/native/yts.js";
import { configuredProviders } from "../lib/search/provider.js";
import { findAuthorizedSources } from "../lib/search/service.js";
import {
  changeNativeSource,
  nativeSourceHealth,
  nativeSourcesPath,
  publicNativeSources,
  readNativeSources,
} from "../lib/settings/native-sources.js";

const hash = "a".repeat(40);
const movie = { title: "Sintel", type: "movie", imdbId: "tt1727587", year: 2010 };
const show = { title: "Example", type: "show", imdbId: "tt123", season: 2, episode: 3 };
const fixtures = {
  knaben: { hits: [{ title: "Sintel 2010", bytes: 1000, seeders: 3, peers: 1, hash, tracker: "Example" }] },
  yts: { status: "ok", data: { movie_count: 1, movies: [{ title: "Sintel", year: 2010, imdb_code: movie.imdbId,
    torrents: [{ hash, quality: "1080p", type: "bluray", video_codec: "x264", size_bytes: 1000, seeds: 5, peers: 2 }] }] } },
  eztv: { torrents_count: 1, torrents: [{ title: "Example S02E03", imdb_id: "123", season: "2", episode: "3",
    hash: "b".repeat(40), seeds: 3, peers: 1, size_bytes: "1000", magnet_url: `magnet:?xt=urn:btih:${"b".repeat(40)}` }] },
};

test("native adapters build requests, honor media capabilities, and map results", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url: new URL(url), options });
    if (options.method === "POST") return Response.json(fixtures.knaben);
    if (new URL(url).pathname.endsWith("list_movies.json")) return Response.json(fixtures.yts);
    return Response.json(fixtures.eztv);
  };
  const options = { fetchImpl, signal: new AbortController().signal };
  assert.equal((await searchKnaben(movie, options))[0].indexer, "Example");
  assert.equal(JSON.parse(requests[0].options.body).query, "Sintel 2010");
  assert.equal((await searchYts(movie, options))[0].resolution, "1080p");
  assert.equal(requests[1].url.searchParams.get("query_term"), movie.imdbId);
  assert.equal((await searchEztv(show, options))[0].media.episode, 3);
  assert.equal(requests[2].url.searchParams.get("imdb_id"), "123");
  assert.deepEqual(await searchYts(show, options), []);
  assert.deepEqual(await searchEztv(movie, options), []);
  assert.deepEqual(await searchEztv({ ...show, imdbId: null }, options), []);
});

test("TV queries are bounded and filter unrelated identities and episodes", async () => {
  const knabenQueries = [];
  await searchKnaben(show, { fetchImpl: async (_, options) => {
    knabenQueries.push(JSON.parse(options.body).query);
    return Response.json({ hits: [] });
  } });
  assert.deepEqual(knabenQueries, ["Example S02E03", "Example S02"]);

  const pages = [];
  const results = await searchEztv(show, { fetchImpl: async (url) => {
    const page = Number(new URL(url).searchParams.get("page"));
    pages.push(page);
    return Response.json({ torrents_count: 101, torrents: page === 1
      ? Array.from({ length: 100 }, () => ({ ...fixtures.eztv.torrents[0], episode: "4" }))
      : fixtures.eztv.torrents });
  } });
  assert.equal(results.length, 1);
  assert.deepEqual(pages, [1, 2]);
});

test("native adapters reject HTTP and malformed responses and honor cancellation", async () => {
  for (const [search, context] of [[searchKnaben, movie], [searchYts, movie], [searchEztv, show]]) {
    await assert.rejects(search(context, { fetchImpl: async () => Response.json({}) }));
    await assert.rejects(search(context, { fetchImpl: async () => new Response("", { status: 503 }) }));
    const signal = AbortSignal.abort();
    await assert.rejects(search(context, { signal, fetchImpl: async (_, options) => { options.signal.throwIfAborted(); } }));
  }
});

test("native source selection is empty by default and persists add, toggle, and removal", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "torplay-native-"));
  const environment = { TORPLAY_CONFIG_PATH: path.join(directory, "torplay.env") };
  try {
    assert.deepEqual(readNativeSources(environment), []);
    assert.deepEqual(configuredProviders(environment), []);
    assert.equal(publicNativeSources(environment).every((source) => !source.configured && !source.enabled), true);
    let calls = 0;
    assert.deepEqual(await nativeSourceHealth({ environment, fetchImpl: async () => { calls++; } }), []);
    assert.equal(calls, 0);

    await changeNativeSource("add", { id: "yts" }, { environment });
    await changeNativeSource("add", { id: "eztv" }, { environment });
    assert.deepEqual(configuredProviders(environment).map((item) => item.id), ["yts", "eztv"]);
    const health = await nativeSourceHealth({ environment, refresh: true, fetchImpl: async (url) => (
      new URL(url).pathname.endsWith("list_movies.json") ? Response.json(fixtures.yts) : Response.json(fixtures.eztv)
    ) });
    assert.deepEqual(health.map((item) => item.status), ["connected", "connected"]);
    const cachedStatuses = [];
    await nativeSourceHealth({ environment, onCached: (result, stale) => cachedStatuses.push([result.provider, stale]) });
    assert.deepEqual(cachedStatuses, [["yts", false], ["eztv", false]]);
    assert.deepEqual(configuredProviders({ ...environment, TORPLAY_SEARCH_PROVIDERS: "eztv" }).map((item) => item.id), ["eztv"]);
    assert.throws(() => configuredProviders({ ...environment, TORPLAY_SEARCH_PROVIDERS: "knaben" }), /Unknown/);
    await assert.rejects(changeNativeSource("add", { id: "yts" }, { environment }), /already configured/);
    await assert.rejects(changeNativeSource("add", { id: "unknown" }, { environment }), /Unknown/);

    await changeNativeSource("update", { id: "yts", enabled: false }, { environment });
    assert.deepEqual(configuredProviders(environment).map((item) => item.id), ["eztv"]);
    assert.deepEqual(configuredProviders({ ...environment, TORPLAY_SEARCH_PROVIDERS: "yts" }), []);
    await changeNativeSource("remove", { id: "eztv" }, { environment });
    assert.deepEqual(readNativeSources(environment), [{ id: "yts", enabled: false }]);
    if (process.platform !== "win32") assert.equal((await stat(nativeSourcesPath(environment))).mode & 0o777, 0o600);
    assert.equal((await readFile(nativeSourcesPath(environment), "utf8")).includes("YTS"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("native health reports a fast source before a slow source finishes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "torplay-health-stream-"));
  const environment = { TORPLAY_CONFIG_PATH: path.join(directory, "torplay.env") };
  try {
    await changeNativeSource("add", { id: "yts" }, { environment });
    await changeNativeSource("add", { id: "eztv" }, { environment });
    let finishEztv;
    let reportYts;
    const ytsReported = new Promise((resolve) => { reportYts = resolve; });
    const reports = [];
    const health = nativeSourceHealth({ environment, refresh: true,
      fetchImpl: async (url) => new URL(url).pathname.endsWith("list_movies.json")
        ? Response.json(fixtures.yts)
        : new Promise((resolve) => { finishEztv = () => resolve(Response.json(fixtures.eztv)); }),
      onResult: (result) => { reports.push(result.provider); if (result.provider === "yts") reportYts(); },
    });
    await ytsReported;
    assert.deepEqual(reports, ["yts"]);
    finishEztv();
    await health;
    assert.deepEqual(reports, ["yts", "eztv"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("invalid native source files fail closed", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "torplay-native-"));
  const environment = { TORPLAY_CONFIG_PATH: path.join(directory, "torplay.env") };
  try {
    await writeFile(nativeSourcesPath(environment), JSON.stringify([{ id: "unknown", enabled: true }]));
    assert.throws(() => readNativeSources(environment), /could not be read/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("configured native sources provide movie and TV results without Jackett", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "torplay-native-"));
  const environment = { TORPLAY_CONFIG_PATH: path.join(directory, "torplay.env") };
  const previous = globalThis.fetch;
  try {
    for (const id of ["yts", "eztv", "knaben"]) await changeNativeSource("add", { id }, { environment });
    const providers = configuredProviders(environment);
    assert.deepEqual(providers.map((item) => item.id), ["yts", "eztv", "knaben"]);
    globalThis.fetch = async (url, options) => {
      const address = new URL(url);
      if (options.method === "POST") return Response.json(fixtures.knaben);
      if (address.pathname.endsWith("list_movies.json")) return Response.json(fixtures.yts);
      return Response.json(fixtures.eztv);
    };
    const movieResults = await findAuthorizedSources(movie, { providers });
    const showResults = await findAuthorizedSources(show, { providers });
    assert.equal(movieResults.some((item) => item.providerId === "yts"), true);
    assert.equal(showResults.some((item) => item.providerId === "eztv"), true);
    assert.equal([...movieResults, ...showResults].some((item) => item.providerId === "jackett"), false);
  } finally {
    globalThis.fetch = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("source chooser preserves existing source paths beside optional tested sources", async () => {
  const [dialog, community] = await Promise.all([
    readFile(new URL("../components/AddSourceDialog.js", import.meta.url), "utf8"),
    readFile(new URL("../components/CommunitySources.js", import.meta.url), "utf8"),
  ]);
  assert.match(dialog, /TorPlay Tested Sources/);
  assert.match(dialog, /None are added or enabled automatically/);
  assert.match(dialog, /<CommunitySources/);
  assert.match(community, /Browse community sources/);
  assert.match(community, /Advanced setup/);
});
