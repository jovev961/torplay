import assert from "node:assert/strict";
import test from "node:test";
import { search } from "../lib/sources/discovery.js";
import { resolve } from "../lib/sources/results.js";
import { createDatabase } from "../lib/database/sqlite.js";
import { cardigann, response, rss, html, torznab, movie, episode, hash } from "./helpers/sources-fixtures.js";

test("all source families produce the same safe public contract", async () => {
  const cases = [
    [torznab(), () => response(rss("The Tailor 2023 1080p", '<link>https://fixture.example/download?apikey=hidden</link>'))],
    [{ id: "yts", name: "YTS", kind: "native", enabled: true }, () => response({ status: "ok", data: { movies: [{ title: "The Tailor", year: 2023,
      torrents: [{ hash, seeds: 12, url: "https://fixture.example/download?token=hidden" }] }] } })],
    [cardigann(), () => response(html())],
  ];
  const shapes = [];
  for (const [source, request] of cases) {
    const result = await search(movie, { sources: [source], request });
    assert.equal(result.candidates.length, 1);
    const candidate = result.candidates[0];
    shapes.push(Object.keys(candidate).sort());
    assert.equal(candidate.kind, "torrent");
    assert.equal(candidate.sourceId, source.id);
    assert.equal(candidate.seeders, 12);
    assert.ok(resolve(candidate.id, "torrent"));
    assert.doesNotMatch(JSON.stringify(result), /hidden|synthetic-secret|magnet:|download\?|infoHash|locator/);
  }
  assert.deepEqual(shapes[0], shapes[1]); assert.deepEqual(shapes[0], shapes[2]);
});

test("native TV integration normalizes the requested episode", async () => {
  let requestUrl;
  const result = await search(episode, { sources: [{ id: "eztv", name: "EZTV", kind: "native", enabled: true }], request: async (url) => {
    requestUrl = url; return response({ torrents_count: 1, torrents: [{ title: "The Tailor S02E03 1080p", hash, imdb_id: "1234567", season: "2", episode: "3", seeds: 8 }] });
  } });
  assert.equal(requestUrl.searchParams.get("imdb_id"), "1234567");
  assert.equal(result.candidates[0].seeders, 8);
});

test("aggregator provenance distinguishes the contacted source from upstream origin", async () => {
  const result = await search(movie, { sources: [{ id: "knaben", name: "Knaben", kind: "native", enabled: true }], request: async () => response({ hits: [{
    title: "The Tailor 2023", hash, tracker: "Upstream Fixture", seeders: 5,
  }] }) });
  assert.equal(result.candidates[0].sourceId, "knaben");
  assert.equal(result.candidates[0].sourceName, "Knaben");
  assert.equal(result.candidates[0].origin, "Upstream Fixture");
});

test("unrelated providers start concurrently and successful candidates survive failure", async () => {
  let started = 0; let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const result = await search(movie, { sources: [torznab("first"), torznab("second")], timeoutMs: 200,
    request: async (url) => {
      started++; if (started === 2) release(); await barrier;
      if (url.hostname === "second.example") throw new Error("private token=fixture-secret");
      return response(rss());
    } });
  assert.equal(started, 2);
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(result.diagnostics.map((d) => d.status).sort(), ["ready", "unavailable"]);
  assert.doesNotMatch(JSON.stringify(result.diagnostics), /fixture-secret|token=/);
});

test("deadline aborts hung source without losing successful empty source", async () => {
  let aborted = false;
  const started = performance.now();
  const result = await search(movie, { sources: [torznab("empty"), torznab("hung")], timeoutMs: 30,
    request: async (url, { signal }) => {
      if (url.hostname === "empty.example") return response("<rss><channel/></rss>");
      return new Promise((_, reject) => signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true }));
    } });
  assert.ok(performance.now() - started < 1000);
  assert.equal(aborted, true);
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.diagnostics.map((d) => d.status).sort(), ["ready", "timed-out"]);
});

test("caller cancellation aborts every in-flight source and stops updates", async () => {
  const controller = new AbortController();
  let started = 0; let aborted = 0; let updates = 0;
  const run = search(movie, { sources: [torznab("one"), torznab("two")], signal: controller.signal,
    onUpdate: () => { updates++; }, request: async (_url, { signal }) => {
      started++; if (started === 2) queueMicrotask(() => controller.abort());
      return new Promise((_, reject) => signal.addEventListener("abort", () => { aborted++; reject(signal.reason); }, { once: true }));
    } });
  await assert.rejects(run, { name: "AbortError" });
  assert.equal(started, 2); assert.equal(aborted, 2); assert.equal(updates, 0);
});

test("pre-cancelled discovery never contacts a source", async () => {
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  await assert.rejects(search(movie, { sources: [torznab()], signal: controller.signal, request: () => { calls++; } }), { name: "AbortError" });
  assert.equal(calls, 0);
});

test("successful empty search differs from authentication and invalid-response failures", async () => {
  const result = await search(movie, { sources: [torznab("empty"), torznab("auth"), torznab("invalid")], request: async (url) => {
    if (url.hostname === "auth.example") return response("fixture-secret", url, 401);
    return response(url.hostname === "empty.example" ? "<rss><channel/></rss>" : "bad xml", url);
  } });
  assert.deepEqual(result.diagnostics.map((d) => d.status).sort(), ["authentication-failed", "invalid-response", "ready"]);
  assert.equal(result.diagnostics.find((d) => d.status === "ready").count, 0);
});

test("all failed searches return bounded diagnostics rather than an empty success", async () => {
  await assert.rejects(search(movie, { sources: [torznab()], request: async () => response("<error code='100'/>") }), (error) => {
    assert.equal(error.code, "SOURCES_UNAVAILABLE");
    assert.equal(error.diagnostics[0].status, "authentication-failed"); return true;
  });
});

test("late source rejection after a deadline does not leak secrets or become unhandled", async (t) => {
  const unhandled = []; const logged = [];
  const listener = (error) => unhandled.push(error);
  process.on("unhandledRejection", listener); t.after(() => process.off("unhandledRejection", listener));
  for (const method of ["log", "warn", "error"]) t.mock.method(console, method, (...values) => logged.push(values.join(" ")));
  const result = await search(movie, { sources: [torznab("empty"), torznab("late")], timeoutMs: 5, request: async (url) => {
    if (url.hostname === "empty.example") return response("<rss><channel/></rss>");
    await new Promise((resolve) => setTimeout(resolve, 20));
    throw new Error("synthetic-private-token https://private.example/download?apikey=fixture");
  } });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(unhandled, []);
  assert.doesNotMatch(JSON.stringify({ diagnostics: result.diagnostics, logged }), /synthetic-private-token|private\.example|apikey/);
});

test("opaque IDs remain stable through progressive updates for an unchanged candidate", async () => {
  const ids = [];
  await search(movie, { sources: [torznab("one"), torznab("two")], onUpdate: (update) => {
    const candidate = update.candidates.find((c) => c.sourceId === "one"); if (candidate) ids.push(candidate.id);
  }, request: async (url) => {
    if (url.hostname === "two.example") { await new Promise((resolve) => setTimeout(resolve, 5)); return response("<rss><channel/></rss>"); }
    return response(rss());
  } });
  assert.ok(ids.length > 1); assert.equal(new Set(ids).size, 1);
});

test("aliases can succeed independently and normalize back to the requested media", async () => {
  const result = await search({ ...movie, originalTitle: "Terzi" }, { sources: [torznab()], request: async (url) => {
    if (url.searchParams.get("q") === "The Tailor") throw new Error("unavailable");
    return response(rss("Terzi 2023 1080p"));
  } });
  assert.equal(result.candidates.length, 1);
});

test("persistent replay keeps private data out of storage and refresh bypasses cache", async (t) => {
  const database = createDatabase(":memory:"); t.after(() => database.close());
  let calls = 0;
  const options = { sources: [torznab()], cacheDatabase: database, usePersistentCache: true,
    request: async () => { calls++; return response(rss()); } };
  const live = await search(movie, options);
  const replay = await search(movie, { ...options, cacheOnly: true });
  assert.equal(calls, 1); assert.equal(replay.candidates.length, 1);
  assert.notEqual(live.candidates[0].id, replay.candidates[0].id);
  assert.ok(resolve(replay.candidates[0].id, "torrent"));
  const rows = database.prepare("SELECT value_json FROM external_response_cache").all();
  assert.doesNotMatch(JSON.stringify(rows), /synthetic-secret|https:|magnet:|resolver/);
  await search(movie, { ...options, refresh: true }); assert.equal(calls, 2);
  const changed = await search(movie, { ...options, sources: [torznab("fixture", { apiKey: "changed" })], cacheOnly: true });
  assert.deepEqual(changed.candidates, []);
});
