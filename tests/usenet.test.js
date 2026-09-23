import assert from "node:assert/strict";
import { test } from "node:test";
import { createDatabase } from "../lib/database/sqlite.js";
import { readUsenetConfig, publicUsenetConfig, validateIndexer } from "../lib/usenet/config.js";
import { fetchNzb, parseNewznabResults, validateNzb } from "../lib/usenet/newznab.js";
import { findUsenetSources } from "../lib/usenet/search.js";
import { createUsenetJob, deleteUsenetJob, getUsenetJob, listUsenetJobs, playUsenetJob } from "../lib/usenet/jobs.js";
import { normalizeTorBoxJob, TorBoxUsenet } from "../lib/usenet/torbox.js";
import { stopPlayback } from "../lib/debrid/session.js";

const nzb = Buffer.from('<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb"><file subject="example"><groups><group>alt.test</group></groups><segments><segment bytes="1" number="1">a@b</segment></segments></file></nzb>');

test("Usenet defaults off and indexer credentials are redacted", async () => {
  assert.deepEqual(await readUsenetConfig({ path: "/tmp/torplay-missing-usenet-settings.json" }), { enabled: false, indexers: [] });
  const indexer = validateIndexer({ name: "Example", endpoint: "https://indexer.example/api", apiKey: "secret" });
  assert.equal(publicUsenetConfig({ enabled: true, indexers: [indexer] }).indexers[0].apiKey, undefined);
  assert.throws(() => validateIndexer({ name: "Local", endpoint: "http://127.0.0.1/api", apiKey: "secret" }));
});

test("NZB parser rejects oversized and entity-bearing files", () => {
  assert.equal(validateNzb(nzb), nzb);
  assert.throws(() => validateNzb(Buffer.from('<!DOCTYPE nzb [<!ENTITY x SYSTEM "file:///etc/passwd">]><nzb/>')));
  assert.throws(() => validateNzb(Buffer.alloc(2_000_001)));
});

test("Newznab only accepts same-origin NZB links and never projects API keys", () => {
  const xml = Buffer.from(`<rss><channel><item><title>Example S01E03</title><enclosure url="https://indexer.example/api?t=get&amp;id=1&amp;apikey=secret" length="123" /></item><item><title>Unsafe</title><link>http://127.0.0.1/nzb</link></item></channel></rss>`);
  const results = parseNewznabResults(xml, { id: "one", name: "Example", endpoint: "https://indexer.example/api", apiKey: "secret" });
  assert.equal(results.length, 1);
  assert.equal(results[0].kind, "nzb");
  assert.equal(results[0].size, 123);
});

test("NZB retrieval blocks cross-origin URLs before opening a connection", async () => {
  await assert.rejects(fetchNzb({ endpoint: "https://indexer.example/api", apiKey: "secret" },
    "https://other.example/secret.nzb"), /outside the configured indexer/);
});

test("disabled Usenet discovery stays empty and enabled results use an opaque reference", async () => {
  const context = { type: "movie", title: "Sintel", tmdbId: 1 };
  const indexer = { id: "one", name: "Example", endpoint: "https://indexer.example/api", apiKey: "secret" };
  assert.deepEqual(await findUsenetSources(context, { readConfig: async () => ({ enabled: false, indexers: [indexer] }) }), []);
  const results = await findUsenetSources(context, {
    readConfig: async () => ({ enabled: true, indexers: [indexer] }),
    search: async () => [{ title: "Sintel 2010", nzbUrl: "https://indexer.example/api?t=get&id=1&apikey=secret",
      indexerId: "one", indexer: "Example", size: 100 }],
  });
  assert.equal(results[0].kind, "nzb");
  assert.equal(results[0].nzbUrl, undefined);
  assert.equal(JSON.stringify(results).includes("secret"), false);
});

test("TorBox job normalization keeps real progress and files", () => {
  const pending = normalizeTorBoxJob({ id: 10, download_state: "downloading", progress: 0.4 });
  assert.equal(pending.status, "downloading");
  assert.equal(pending.progress, 0.4);
  const ready = normalizeTorBoxJob({ id: 10, download_finished: true,
    files: [{ id: 4, name: "Show/Show.S01E03.mkv", size: 100 }] });
  assert.equal(ready.status, "ready");
  assert.equal(ready.files[0].providerId, "4");
});

test("TorBox recognizes account restrictions and submits raw NZB privately", async () => {
  const calls = [];
  const provider = new TorBoxUsenet("secret", { fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).includes("mylist")) return Response.json({ success: false, error: "PLAN_RESTRICTED_FEATURE", data: null }, { status: 403 });
    return Response.json({ success: true, data: { usenetdownload_id: "27" } });
  } });
  assert.equal(await provider.capability(), "unavailable");
  assert.equal(await provider.create(nzb), 27);
  assert.equal(calls[1].options.headers.Authorization, "Bearer secret");
  assert.equal(calls[1].options.body.get("file").name, "upload.nzb");
});

test("owned jobs survive session stop, select episode, and delete explicitly", async () => {
  const database = createDatabase(":memory:");
  let deletes = 0;
  let resolvedFile = null;
  const provider = {
    capability: async () => "available",
    create: async () => 77,
    get: async () => ({ id: 77, status: "ready", progress: 1, files: [
      { providerId: "1", name: "Show.S01E01.mkv", path: "Show.S01E01.mkv", size: 100 },
      { providerId: "3", name: "Show.S01E03.mkv", path: "Show.S01E03.mkv", size: 101 },
    ] }),
    resolveStream: async (_job, file) => {
      resolvedFile = file.providerId;
      return { url: `https://cdn.example/${file.providerId}` };
    },
    delete: async () => { deletes += 1; },
  };
  const dependencies = {
    database, provider, probe: async () => {},
    readDebrid: async () => ({ credentials: { torbox: { apiKey: "secret" } } }),
    readUsenet: async () => ({ enabled: true, indexers: [] }),
  };
  try {
    const created = await createUsenetJob({ buffer: nzb, title: "Show", mediaContext: {
      type: "show", season: 1, episode: 3, tmdbId: 5,
    } }, dependencies);
    assert.equal((await listUsenetJobs(dependencies)).length, 1);
    const session = await playUsenetJob(created.id, dependencies);
    assert.equal(session.sourceType, "usenet");
    assert.equal(resolvedFile, "3");
    assert.equal(session.files.length, 2);
    await stopPlayback(session.id);
    assert.equal(deletes, 0);
    assert.equal((await getUsenetJob(created.id, dependencies)).status, "ready");
    await deleteUsenetJob(created.id, dependencies);
    assert.equal(deletes, 1);
    assert.equal((await listUsenetJobs(dependencies)).length, 0);
  } finally { database.close(); }
});
