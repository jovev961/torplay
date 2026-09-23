import assert from "node:assert/strict";
import test from "node:test";
import { createDatabase } from "../lib/database/sqlite.js";
import { normalizeCandidate } from "../lib/search/contract.js";
import { PROVIDER_RESULT_CACHE_TTL_MS, searchConfiguredProvider } from "../lib/search/provider.js";
import { uniqueResults } from "../lib/search/processing.js";
import { findAuthorizedSources } from "../lib/search/service.js";
import { parseTorznabXml } from "../lib/search/torznab-xml.js";

const hash = "0123456789012345678901234567890123456789";
const context = { title: "Sintel", type: "movie" };
const candidate = { title: "Sintel", infoHash: hash, seeders: 10 };
const provider = (id, search) => ({ id, name: id, search });
const quiet = { onFailure: () => {} };

test("normalizes hash-only candidates and strips unknown provider payload", () => {
  const result = normalizeCandidate({ ...candidate, privatePayload: "secret", size: -1, leechers: "3",
    media: { type: "movie", year: 2010, privateField: "secret" } }, provider("native"));
  assert.equal(result.source.magnet, `magnet:?xt=urn:btih:${hash}`);
  assert.equal(result.size, 0);
  assert.equal(result.leechers, 3);
  assert.equal(result.codec, null);
  assert.equal(result.media.year, 2010);
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.equal(normalizeCandidate({ title: "Invalid", source: { downloadUrl: "file:///secret" } }, provider("native")), null);
  assert.equal(normalizeCandidate({ ...candidate, title: "" }, provider("native")), null);
  assert.equal(normalizeCandidate({ title: "v2 only", infoHash: "a".repeat(64) }, provider("native")), null);
});

test("Torznab and replacement-provider candidates pass through the same contract", async () => {
  const xml = `<rss><channel><item><title>Sintel</title><torznab:attr name="infohash" value="${hash}"/><torznab:attr name="seeders" value="2"/><torznab:attr name="peers" value="5"/></item></channel></rss>`;
  for (const search of [async () => [candidate], async () => parseTorznabXml(xml)]) {
    const results = await searchConfiguredProvider(context, { ...quiet, providers: [provider("test", search)] });
    assert.equal(results[0].providerId, "test");
    assert.equal(results[0].infoHash, hash);
    assert.equal(results[0].source.magnet, `magnet:?xt=urn:btih:${hash}`);
  }
});

test("providers fail independently with sanitized diagnostics and stable ordering", async () => {
  const failures = [];
  const results = await searchConfiguredProvider(context, {
    providers: [
      provider("first", async () => { await new Promise((resolve) => setTimeout(resolve, 5)); return [candidate]; }),
      provider("broken", () => { throw new Error("apikey=secret"); }),
      provider("malformed", async () => ({})),
      provider("last", async () => [{ ...candidate, title: "Last" }, null]),
    ],
    onFailure: (failure) => failures.push(failure),
  });
  assert.deepEqual(results.map((item) => item.providerId), ["first", "last"]);
  assert.deepEqual(failures, [{ providerId: "broken", category: "failed" }, { providerId: "malformed", category: "failed" }]);
});

test("deadlines abort a hung provider without losing successful empty responses", async () => {
  let signal;
  const hung = provider("hung", async (_, options) => { signal = options.signal; return new Promise(() => {}); });
  assert.deepEqual(await searchConfiguredProvider(context, {
    ...quiet, timeoutMs: 5, providers: [hung, provider("empty", async () => [])],
  }), []);
  assert.equal(signal.aborted, true);
  await assert.rejects(searchConfiguredProvider(context, { ...quiet, timeoutMs: 5, providers: [hung] }), (error) => error.status === 504);
  await assert.rejects(searchConfiguredProvider(context, { ...quiet, providers: [provider("bad", () => { throw new Error("secret"); })] }),
    (error) => error.status === 502 && !error.message.includes("secret"));
  await assert.rejects(searchConfiguredProvider(context, { providers: [] }), (error) => (
    error.status === 503 && error.code === "NO_TORRENT_SOURCES"
  ));
});

test("service exposes safe optional metadata and supports providers without consumer changes", async () => {
  const results = await findAuthorizedSources(context, {
    providers: [provider("native", async () => [{ ...candidate, resolution: "1080p", leechers: 2 }])],
  });
  assert.equal(results[0].providerId, "native");
  assert.equal(results[0].resolution, "1080p");
  assert.equal(results[0].verification, "magnet");
  assert.equal(JSON.stringify(results).includes("magnet:"), false);
});

test("does not cache a provider result by downgrading its direct torrent source", async () => {
  const database = createDatabase(":memory:");
  let calls = 0;
  const cachedProvider = provider("cached", async () => {
    calls += 1;
    return [{
      ...candidate,
      source: { downloadUrl: "https://provider.test/torrent?apikey=server-secret" },
    }];
  });
  const options = {
    ...quiet,
    providers: [cachedProvider],
    usePersistentCache: true,
    cacheDatabase: database,
    now: 1_000,
  };
  try {
    const first = await searchConfiguredProvider(context, options);
    const second = await searchConfiguredProvider(context, { ...options, now: 2_000 });
    assert.equal(calls, 2);
    assert.equal(second[0].title, first[0].title);
    assert.equal(second[0].source.downloadUrl, "https://provider.test/torrent?apikey=server-secret");
    const stored = database.prepare("SELECT cache_key, value_json FROM external_response_cache WHERE namespace = 'provider-results'").get();
    assert.equal(stored, undefined);
  } finally {
    database.close();
  }
});

test("persists short-lived magnet-only provider results", async () => {
  const database = createDatabase(":memory:");
  let calls = 0;
  const cachedProvider = provider("cached", async () => {
    calls += 1;
    return [candidate];
  });
  const options = {
    ...quiet,
    providers: [cachedProvider],
    usePersistentCache: true,
    cacheDatabase: database,
    now: 1_000,
  };
  try {
    const first = await searchConfiguredProvider(context, options);
    const second = await searchConfiguredProvider(context, { ...options, now: 2_000 });
    assert.equal(calls, 1);
    assert.equal(second[0].source.magnet, first[0].source.magnet);
    await searchConfiguredProvider(context, {
      ...options,
      now: 1_000 + PROVIDER_RESULT_CACHE_TTL_MS + 1,
    });
    assert.equal(calls, 2);
  } finally {
    database.close();
  }
});

test("deduplication keeps the strongest startup path for the same swarm", () => {
  const magnetOnly = normalizeCandidate({ ...candidate, seeders: 100 }, provider("magnet"));
  const resolvable = normalizeCandidate({
    ...candidate,
    seeders: 5,
    source: { resolver: async () => ({ magnet: `magnet:?xt=urn:btih:${hash}` }) },
  }, provider("resolver"));
  const direct = normalizeCandidate({
    ...candidate,
    seeders: 1,
    source: { downloadUrl: "https://provider.test/torrent" },
  }, provider("direct"));

  assert.equal(uniqueResults([magnetOnly, resolvable, direct])[0].providerId, "direct");
  assert.equal(uniqueResults([magnetOnly, resolvable])[0].providerId, "resolver");
});
