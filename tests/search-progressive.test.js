import assert from "node:assert/strict";
import test from "node:test";
import { createDatabase } from "../lib/database/sqlite.js";
import { searchConfiguredProvider } from "../lib/search/provider.js";
import { findAuthorizedSourcesProgressive } from "../lib/search/service.js";
import { getSearchResult } from "../lib/search/result-store.js";
import { readNdjson } from "../components/readNdjson.js";

const hash = "0123456789012345678901234567890123456789";
const magnet = `magnet:?xt=urn:btih:${hash}`;
const context = { title: "Sintel", type: "movie" };
const provider = (id, search) => ({ id, name: id, search });

test("fast provider results arrive before a slow provider finishes", async () => {
  let finishSlow;
  let signalFirst;
  const first = new Promise((resolve) => { signalFirst = resolve; });
  const snapshots = [];
  const search = findAuthorizedSourcesProgressive(context, {
    providers: [
      provider("fast", async () => [{ title: "Sintel fast", infoHash: hash }]),
      provider("slow", () => new Promise((resolve) => { finishSlow = resolve; })),
    ],
    onFailure: () => {},
    onResults: (results) => { snapshots.push(results); if (results.length) signalFirst(); },
  });
  await first;
  assert.equal(snapshots[0][0].verification, "magnet");
  assert.equal(snapshots[0][0].canStart, true);
  finishSlow([]);
  const final = await search;
  assert.equal(final.length, 1);
  assert.equal(final[0].verification, "magnet");
});

test("direct results appear pending and update after validation", async () => {
  let finishInspection;
  let signalPending;
  let signalInspecting;
  const pending = new Promise((resolve) => { signalPending = resolve; });
  const inspecting = new Promise((resolve) => { signalInspecting = resolve; });
  const snapshots = [];
  const search = findAuthorizedSourcesProgressive(context, {
    providers: [provider("direct", async () => [{ title: "Sintel direct", infoHash: hash,
      source: { downloadUrl: "https://provider.test/torrent?apikey=server-secret" } }])],
    onFailure: () => {},
    inspectSource: () => new Promise((resolve) => { finishInspection = resolve; signalInspecting(); }),
    onResults: (results) => {
      snapshots.push(results);
      if (results[0]?.verification === "checking") signalPending();
    },
  });
  await pending;
  await inspecting;
  assert.equal(snapshots[0][0].canStart, false);
  assert.equal(JSON.stringify(snapshots).includes("server-secret"), false);
  finishInspection({ playbackMode: "native" });
  const final = await search;
  assert.equal(final[0].verification, "verified");
  assert.equal(getSearchResult(final[0].id).downloadUrl.includes("server-secret"), true);
});

test("aborting a search stops waiting for an unresponsive provider", async () => {
  const controller = new AbortController();
  const search = searchConfiguredProvider(context, {
    providers: [provider("hung", () => new Promise(() => {}))],
    signal: controller.signal, onFailure: () => {},
  });
  controller.abort();
  await assert.rejects(search, (error) => error.name === "AbortError");
});

test("cached hash preview remains a separate magnet source when a direct result refreshes", async () => {
  const database = createDatabase(":memory:");
  let calls = 0;
  const direct = provider("direct", async () => {
    calls += 1;
    return [{ title: "Sintel direct", infoHash: hash,
      source: { downloadUrl: "https://provider.test/torrent?apikey=server-secret" } }];
  });
  const options = { providers: [direct], usePersistentCache: true,
    cacheDatabase: database, now: 1_000, onFailure: () => {} };
  try {
    await searchConfiguredProvider(context, options);
    const restored = await searchConfiguredProvider(context, { ...options, now: 1_500, cacheOnly: true });
    assert.equal(calls, 1);
    assert.equal(restored[0].source.magnet, magnet);
    assert.equal(restored[0].source.downloadUrl, null);
    const batches = [];
    const result = await findAuthorizedSourcesProgressive(context, {
      ...options, onResults: (results) => { if (results.length) batches.push(results); },
      inspectSource: async () => ({ playbackMode: "native" }),
    });
    assert.equal(calls, 2);
    assert.equal(batches[0][0].verification, "magnet");
    assert.equal(getSearchResult(batches[0][0].id).magnet, magnet);
    assert.equal(getSearchResult(batches[0][0].id).downloadUrl, null);
    assert.notEqual(result[0].id, batches[0][0].id);
    assert.equal(result[0].verification, "verified");
  } finally { database.close(); }
});

test("cache-only progressive search reports cache age without calling providers", async () => {
  const database = createDatabase(":memory:");
  let calls = 0;
  const cached = provider("cached", async () => { calls += 1; return [{ title: "Sintel", infoHash: hash }]; });
  const options = { providers: [cached], usePersistentCache: true,
    cacheDatabase: database, now: 1_000, onFailure: () => {} };
  try {
    await searchConfiguredProvider(context, options);
    const snapshots = [];
    const results = await findAuthorizedSourcesProgressive(context, {
      ...options, now: 2_000, cacheOnly: true,
      onResults: (items, cache) => snapshots.push({ items, cache }),
    });
    assert.equal(calls, 1);
    assert.equal(results.length, 1);
    assert.deepEqual(snapshots.at(-1).cache, { status: "all", oldestCreatedAt: 1_000 });
    assert.equal(JSON.stringify(results).includes("cacheCreatedAt"), false);
  } finally { database.close(); }
});

test("NDJSON reader handles frames split across chunks", async () => {
  const bytes = new TextEncoder();
  const response = new Response(new ReadableStream({ start(controller) {
    controller.enqueue(bytes.encode('{"type":"results","results":['));
    controller.enqueue(bytes.encode(']}\n{"type":"complete"}\n'));
    controller.close();
  } }), { headers: { "Content-Type": "application/x-ndjson" } });
  const events = [];
  await readNdjson(response, (event) => events.push(event));
  assert.deepEqual(events.map((event) => event.type), ["results", "complete"]);
});
