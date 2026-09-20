import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { changeCustomProvider, customProvidersPath, readCustomProviders, publicCustomProviders, customProviderHealth } from "../lib/settings/torrent-providers.js";
import { customTorznabAdapter, testTorznab, torznabEndpoint } from "../lib/search/torznab.js";
import { configuredProviders, searchConfiguredProvider } from "../lib/search/provider.js";
import { POST } from "../app/api/settings/torrent-providers/route.js";

const caps = '<caps><searching><search available="yes" supportedParams="q"/><movie-search available="yes" supportedParams="q,imdbid"/><tv-search available="yes" supportedParams="q,season,ep"/></searching><categories><category id="2000"/><category id="5000"/></categories></caps>';
const feed = '<rss><channel><item><title>Sintel 2010</title><torznab:attr name="infohash" value="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"/><torznab:attr name="seeders" value="5"/></item></channel></rss>';
const fetchImpl = async (url) => new Response(new URL(url).searchParams.get("t") === "caps" ? caps : feed);
const values = { name: "My indexer", endpoint: "http://localhost:9696/1/api", apiKey: "private-key" };

test("custom provider changes persist atomically, redact secrets, and preserve keys on edit", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "torplay-custom-"));
  const environment = { TORPLAY_CONFIG_PATH: path.join(directory, "torplay.env") };
  try {
    const [created] = await changeCustomProvider("create", values, { environment, fetchImpl });
    assert.match(created.id, /^custom-/);
    assert.deepEqual(created.mediaTypes, ["Movies", "TV"]);
    assert.equal(JSON.stringify(created).includes("private-key"), false);
    assert.equal(publicCustomProviders(environment)[0].endpoint, undefined);
    assert.equal(readCustomProviders(environment)[0].apiKey, "private-key");
    if (process.platform !== "win32") assert.equal((await stat(customProvidersPath(environment))).mode & 0o777, 0o600);
    await changeCustomProvider("update", { id: created.id, name: "Renamed", apiKey: "" }, { environment, fetchImpl });
    assert.equal(readCustomProviders(environment)[0].apiKey, "private-key");
    const before = await readFile(customProvidersPath(environment), "utf8");
    await assert.rejects(changeCustomProvider("update", { id: created.id, apiKey: "bad" }, { environment, fetchImpl: async () => new Response('<error code="100"/>') }), /not saved/);
    assert.equal(await readFile(customProvidersPath(environment), "utf8"), before);
    await assert.rejects(changeCustomProvider("create", values, { environment, fetchImpl }), /already configured/);
    assert.equal(configuredProviders(environment).at(-1).id, created.id);
    assert.deepEqual(configuredProviders({ ...environment, TORPLAY_SEARCH_PROVIDERS: "yts" }).map((p) => p.id), ["yts"]);
    await changeCustomProvider("update", { id: created.id, enabled: false }, { environment, fetchImpl });
    assert.deepEqual(configuredProviders({ ...environment, TORPLAY_SEARCH_PROVIDERS: `yts,${created.id}` }).map((p) => p.id), ["yts"]);
    let calls = 0;
    const [disabled] = await customProviderHealth({ environment, fetchImpl: async () => { calls++; } });
    assert.equal(disabled.status, "disabled"); assert.equal(calls, 0);
    await changeCustomProvider("remove", { id: created.id }, { environment });
    assert.deepEqual(readCustomProviders(environment), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("custom providers may be the only source, may be disabled, and cache health", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "torplay-custom-"));
  const environment = { TORPLAY_CONFIG_PATH: path.join(directory, "config.env"), TORPLAY_NATIVE_PROVIDERS: "" };
  try {
    const [created] = await changeCustomProvider("create", values, { environment, fetchImpl });
    await changeCustomProvider("update", { id: created.id, enabled: false }, { environment });
    assert.equal(readCustomProviders(environment)[0].enabled, false);
    let disabledCalls = 0;
    assert.equal((await customProviderHealth({ environment, fetchImpl: async () => { disabledCalls++; } }))[0].status, "disabled");
    assert.equal(disabledCalls, 0);
    await changeCustomProvider("update", { id: created.id, enabled: true }, { environment });
    let calls = 0;
    const options = { environment, fetchImpl: async (...args) => { calls++; return fetchImpl(...args); } };
    assert.equal((await customProviderHealth(options))[0].status, "connected");
    await customProviderHealth(options); assert.equal(calls, 2);
    await customProviderHealth({ ...options, refresh: true }); assert.equal(calls, 4);
    await changeCustomProvider("remove", { id: created.id }, { environment });
    assert.deepEqual(readCustomProviders(environment), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Torznab validates credentials with search, rejects malformed feeds, and prevents redirects", async () => {
  const requests = [];
  const capabilities = await testTorznab(values, { fetchImpl: async (url, options) => {
    requests.push(new URL(url).searchParams.get("t"));
    assert.equal(options.redirect, "error"); assert.equal(options.signal instanceof AbortSignal, true);
    return fetchImpl(url);
  } });
  assert.deepEqual(requests, ["caps", "search"]);
  assert.deepEqual(capabilities.mediaTypes, ["Movies", "TV"]);
  for (const body of ["<html/>", "not xml", '<error code="100"/>']) {
    await assert.rejects(testTorznab(values, { fetchImpl: async () => new Response(body) }));
  }
  await assert.rejects(testTorznab(values, { fetchImpl: async (url) => new Response(new URL(url).searchParams.get("t") === "caps" ? caps : '<error code="100"/>') }));
  assert.throws(() => torznabEndpoint("http://user:secret@host/api"));
  assert.throws(() => torznabEndpoint("file:///private"));
  assert.throws(() => torznabEndpoint("http://host/api?apikey=secret"));
  const empty = await testTorznab(values, { fetchImpl: async (url) => new Response(new URL(url).searchParams.get("t") === "caps" ? caps : "<rss><channel/></rss>") });
  assert.deepEqual(empty.mediaTypes, ["Movies", "TV"]);
});

test("custom adapter supports movie and TV season variants and isolated failures", async () => {
  const capabilities = await testTorznab(values, { fetchImpl });
  const adapter = customTorznabAdapter({ ...values, id: "custom-test", capabilities });
  const old = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => { requests.push(new URL(url)); return new Response(feed); };
  try {
    assert.equal((await adapter.search({ title: "Sintel", type: "movie" })).length, 1);
    await adapter.search({ title: "Example", type: "show", season: 2, episode: 3 });
    assert.equal(requests[0].searchParams.get("t"), "movie");
    assert.equal(requests[1].searchParams.get("ep"), "3");
    assert.equal(requests[2].searchParams.has("ep"), false);
    const results = await searchConfiguredProvider({ title: "Sintel", type: "movie" }, {
      providers: [adapter, { id: "broken", name: "Broken", search: async () => { throw new Error(); } }], onFailure() {},
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].providerId, "custom-test");
  } finally { globalThis.fetch = old; }
});

test("custom provider route denies LAN mutations and cross-origin tests", async () => {
  for (const headers of [
    { host: "torplay.local", origin: "http://torplay.local" },
    { host: "localhost", origin: "http://evil.example" },
  ]) {
    const response = await POST(new Request("http://localhost/api/settings/torrent-providers", {
      method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ action: "test", provider: values }),
    }));
    assert.equal(response.status, 403);
  }
});

test("generic Torznab search supports movie and TV fallback and limits oversized responses", async () => {
  const genericCaps = '<caps><limits max="10"/><searching><search available="yes" supportedParams="q"/></searching><categories><category id="2000"/><category id="5000"/></categories></caps>';
  const capabilities = await testTorznab(values, { fetchImpl: async (url) => new Response(new URL(url).searchParams.get("t") === "caps" ? genericCaps : "<rss><channel/></rss>") });
  const previous = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => { requests.push(new URL(url)); return new Response("<rss><channel/></rss>"); };
  try {
    const adapter = customTorznabAdapter({ ...values, id: "custom-generic", capabilities });
    assert.deepEqual(await adapter.search({ type: "movie", title: "Sintel" }), []);
    assert.deepEqual(await adapter.search({ type: "show", title: "Example", season: 2, episode: 3 }), []);
    assert.equal(requests[0].searchParams.get("t"), "search");
    assert.equal(requests[0].searchParams.get("limit"), "10");
    assert.equal(requests[1].searchParams.get("q"), "Example S02");
  } finally { globalThis.fetch = previous; }
  await assert.rejects(testTorznab(values, { fetchImpl: async () => new Response("x".repeat(2_000_001)) }), /too large/);
});
