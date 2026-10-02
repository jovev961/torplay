import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GET as getSearch } from "../app/api/search/route.js";
import { POST as settingsPost } from "../app/api/settings/torrent-providers/route.js";
import { POST as startTorrent } from "../app/api/torrents/route.js";
import { findUsenetSources } from "../lib/usenet/search.js";
import { rememberTorrent, resolve } from "../lib/sources/results.js";
import { normalize } from "../lib/sources/contract.js";
import { inspectCandidates, pendingCandidates } from "../lib/torrent/source-inspection.js";
import { hash, magnet, movie, rss, torznab, mockNetwork, settingsFixture } from "./helpers/sources-fixtures.js";

async function routeEnvironment(t) {
  const fixture = await settingsFixture(t);
  for (const [key, value] of Object.entries({ TORPLAY_CONFIG_PATH: fixture.environment.TORPLAY_CONFIG_PATH,
    TORPLAY_DATABASE_PATH: ":memory:", TORPLAY_SEARCH_PROVIDERS: "fixture", JACKETT_MOVIE_INDEXERS: "", JACKETT_SHOW_INDEXERS: "" })) {
    const before = process.env[key]; process.env[key] = value;
    t.after(() => { if (before === undefined) delete process.env[key]; else process.env[key] = before; });
  }
  return fixture;
}

test("search route returns public JSON, private IDs and per-source diagnostics", async (t) => {
  const fixture = await routeEnvironment(t); await fixture.write("torrent-providers.json", [torznab()]);
  mockNetwork(t, () => ({ body: rss() }));
  const response = await getSearch(new Request("http://localhost/api/search?type=movie&q=The+Tailor&year=2023"));
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  const payload = await response.json();
  assert.equal(payload.results.length, 1); assert.equal(payload.diagnostics[0].status, "ready");
  assert.equal(payload.results[0].verification, "magnet"); assert.equal(payload.results[0].canStart, true);
  assert.equal(resolve(payload.results[0].id, "torrent").infoHash, hash);
  assert.doesNotMatch(JSON.stringify(payload), /synthetic-secret|apikey|magnet:|infoHash/);
});

test("streaming route reports results and diagnostics before completion", async (t) => {
  const fixture = await routeEnvironment(t); await fixture.write("torrent-providers.json", [torznab()]);
  mockNetwork(t, () => ({ body: rss() }));
  const response = await getSearch(new Request("http://localhost/api/search?type=movie&q=The+Tailor", { headers: { accept: "application/x-ndjson" } }));
  assert.equal(response.headers.get("content-type"), "application/x-ndjson; charset=utf-8");
  const events = (await response.text()).trim().split("\n").map(JSON.parse);
  assert.equal(events[0].type, "started"); assert.equal(events.at(-1).type, "complete");
  assert.ok(events.some((event) => event.type === "results" && event.results.length === 1));
  assert.ok(events.some((event) => event.type === "diagnostics" && event.diagnostics[0]?.status === "ready"));
});

test("reader cancellation aborts in-flight streaming source work", { timeout: 2000 }, async (t) => {
  const fixture = await routeEnvironment(t); await fixture.write("torrent-providers.json", [torznab()]);
  let start; const started = new Promise((resolve) => { start = resolve; });
  const calls = mockNetwork(t, () => { start(); return new Promise(() => {}); });
  const response = await getSearch(new Request("http://localhost/api/search?type=movie&q=The+Tailor&refresh=1", { headers: { accept: "application/x-ndjson" } }));
  const reader = response.body.getReader(); await reader.read(); await started;
  await reader.cancel(); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls[0].signal.aborted, true);
});

test("invalid route contexts and unknown selections fail without source traffic", async (t) => {
  await routeEnvironment(t);
  const calls = mockNetwork(t, () => { throw new Error("should not contact"); });
  for (const query of ["q=", "q=Fixture&type=show&season=1", "q=Fixture&cacheOnly=true", "q=Fixture&cacheOnly=1&refresh=1"]) {
    assert.equal((await getSearch(new Request(`http://localhost/api/search?${query}`))).status, 400);
  }
  const response = await startTorrent(new Request("http://localhost/api/torrents", { method: "POST",
    headers: { host: "localhost", origin: "http://localhost", "content-type": "application/json" },
    body: JSON.stringify({ resultId: "unknown", action: "local", magnet: "magnet:?xt=arbitrary" }) }));
  assert.equal(response.status, 404); assert.equal(calls.length, 0);
});

test("source Settings mutation rejects public hosts and foreign origins", async (t) => {
  await routeEnvironment(t);
  for (const [host, origin] of [["public.example", "http://public.example"], ["localhost", "https://foreign.example"]]) {
    const result = await settingsPost(new Request(`http://${host}/api/settings/torrent-providers`, { method: "POST",
      headers: { host, origin, "content-type": "application/json" }, body: JSON.stringify({ action: "create", provider: { name: "Fixture", endpoint: "https://fixture.example/api", apiKey: "never-write-fixture" } }) }));
    assert.equal(result.status, 403); assert.ok(!(await result.text()).includes("never-write-fixture"));
  }
});

test("torrent inspection distinguishes selectable magnets from metadata checking", async () => {
  const pure = rememberTorrent(normalize({ title: "Magnet", locator: { magnet } }, torznab()), {});
  const checking = rememberTorrent(normalize({ title: "Metadata", locator: { resolve: async () => ({ magnet }) } }, torznab()), {});
  const candidates = [{ id: pure, title: "Magnet" }, { id: checking, title: "Metadata" }];
  assert.deepEqual(pendingCandidates(candidates).map((row) => [row.canStart, row.verification]), [[true, "magnet"], [false, "checking"]]);
  const rows = await inspectCandidates(candidates, {}, { inspect: async (source) => {
    assert.equal((await source.resolver()).infoHash, hash); return { playbackMode: "native" };
  } });
  assert.equal(rows.find((row) => row.id === checking).verification, "verified");
  assert.ok(rows.every((row) => row.canStart));
});

test("incompatible torrent metadata is hidden even when a magnet exists", async () => {
  const id = rememberTorrent(normalize({ title: "Incompatible", locator: { magnet, resolve: async () => ({ magnet }) } }, torznab()), {});
  assert.deepEqual(await inspectCandidates([{ id, title: "Incompatible" }], {}, { inspect: async () => null }), []);
});

test("Usenet discovery retains private NZB resolution and isolates failed indexers", async () => {
  const rows = await findUsenetSources(movie, { readConfig: async () => ({ enabled: true, indexers: [{ id: "good" }, { id: "bad" }] }),
    search: async (indexer) => {
      if (indexer.id === "bad") throw new Error("synthetic failure");
      return [{ kind: "nzb", title: "The Tailor 2023", indexerId: "good", indexer: "Personal", guid: "fixture", nzbUrl: "https://personal.example/get?apikey=private-key", size: 100 }];
    } });
  assert.equal(rows.length, 1); assert.equal(rows[0].kind, "nzb");
  assert.doesNotMatch(JSON.stringify(rows), /private-key|nzbUrl/);
  assert.equal(resolve(rows[0].id, "nzb").indexerId, "good");
});

async function bundle(entry, reactOverride) {
  const built = await build({ entryPoints: [entry], bundle: true, write: false, platform: "node", format: "cjs",
    jsx: "automatic", loader: { ".js": "jsx" }, external: ["react", "react-dom", "next/*"] });
  const loaded = { exports: {} }; const require = createRequire(import.meta.url);
  new Function("require", "module", "exports", built.outputFiles[0].text)((id) => id === "react" && reactOverride ? reactOverride : require(id), loaded, loaded.exports);
  return loaded.exports;
}

test("movie and TV lookup forward original titles and episode context to discovery", async (t) => {
  const hooks = { useState: (initial) => [initial, () => {}], useRef: (initial) => ({ current: initial }), useCallback: (fn) => fn, useEffect: () => {} };
  const { useSourceLookup } = await bundle("components/useSourceLookup.js", hooks);
  const urls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    urls.push(new URL(url, "http://localhost"));
    return new Response('{"type":"complete"}\n', { headers: { "content-type": "application/x-ndjson" } });
  });
  const lookup = useSourceLookup();
  await lookup.search({ type: "movie", query: "The Tailor", originalTitle: "Terzi" });
  assert.equal(urls[0].searchParams.get("originalTitle"), "Terzi");
  await lookup.search({ type: "show", query: "The Tailor", originalTitle: "Terzi", season: 2, episode: 3 });
  assert.equal(urls[1].searchParams.get("season"), "2");
  assert.equal(urls[1].searchParams.get("episode"), "3");
  assert.equal(urls[1].searchParams.get("originalTitle"), "Terzi");
});

test("source UI displays configured source, upstream origin and safe failures", async () => {
  const { default: SourcePanel } = await bundle("components/SourcePanel.js");
  const lookup = { results: [{ id: "opaque-fixture", title: "The Tailor 2023", sourceName: "Configured Fixture", origin: "Upstream Fixture", canStart: true, verification: "magnet" }],
    usenetResults: [], usenetJobs: [], session: null, startingId: null, readySources: [], hasSearched: true,
    sourceDiagnostics: [{ sourceId: "failed", sourceName: "Failed Fixture", status: "timed-out", message: "Source search timed out." }] };
  const markup = renderToStaticMarkup(createElement(SourcePanel, { lookup, heading: "Movie sources" }));
  assert.ok(markup.includes("Configured Fixture · Upstream Fixture"));
  assert.ok(markup.includes("Source search timed out."));
  assert.ok(markup.includes("Choose torrent")); assert.ok(!markup.includes("magnet:?"));
});
