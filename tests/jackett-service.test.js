import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { jackettEndpoint, listJackettIndexers } from "../lib/search/jackett-service.js";
import { availableJackettIndexers, changeCustomProvider, changeJackettProvider, readCustomProviders } from "../lib/settings/torrent-providers.js";
import { configuredProviders } from "../lib/search/provider.js";

const indexersXml = '<indexers><indexer id="movies" title="Movie source"/><indexer id="shows" title="TV source"/></indexers>';
const capsXml = '<caps><searching><search available="yes" supportedParams="q"/><movie-search available="yes" supportedParams="q"/><tv-search available="yes" supportedParams="q,season,ep"/></searching><categories><category id="2000"/><category id="5000"/></categories></caps>';
const fetchImpl = async (url) => {
  const target = new URL(url);
  assert.equal(target.searchParams.get("apikey"), "secret");
  if (target.searchParams.get("t") === "indexers") return new Response(indexersXml);
  if (target.searchParams.get("t") === "caps") return new Response(capsXml);
  return new Response("<rss><channel></channel></rss>");
};

test("Jackett service discovers configured indexers without exposing its API key", async () => {
  const environment = { JACKETT_URL: "http://localhost:9117", JACKETT_API_KEY: "secret" };
  assert.equal(jackettEndpoint(environment.JACKETT_URL, "movies"), "http://localhost:9117/api/v2.0/indexers/movies/results/torznab/api");
  assert.deepEqual((await listJackettIndexers({ environment, fetchImpl })).map((item) => item.id), ["movies", "shows"]);
  await assert.rejects(listJackettIndexers({ environment: { ...environment, JACKETT_API_KEY: "" }, fetchImpl }), /Configure Jackett/);
});

test("Jackett sources use service credentials, media scope, and survive final removal", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "torplay-jackett-service-"));
  const environment = { TORPLAY_CONFIG_PATH: path.join(directory, "config.env"), JACKETT_URL: "http://localhost:9117", JACKETT_API_KEY: "secret" };
  try {
    const listed = await availableJackettIndexers({ environment, fetchImpl });
    assert.equal(listed[0].added, false);
    const [created] = await changeJackettProvider("create", { indexerId: "movies", mediaTypes: ["Movies"] }, { environment, fetchImpl });
    assert.equal(created.kind, "jackett");
    assert.deepEqual(created.mediaTypes, ["Movies"]);
    assert.equal((await availableJackettIndexers({ environment, fetchImpl }))[0].added, true);
    const stored = await readFile(path.join(directory, "torrent-providers.json"), "utf8");
    assert.equal(stored.includes("secret"), false);
    assert.equal(stored.includes("localhost:9117"), false);
    assert.deepEqual(configuredProviders(environment).map((item) => item.id), [created.id]);
    await assert.rejects(changeJackettProvider("create", { indexerId: "movies", mediaTypes: ["Movies"] }, { environment, fetchImpl }), /already added/);
    await changeJackettProvider("update", { id: created.id, mediaTypes: ["Movies"], enabled: false }, { environment: { ...environment, JACKETT_API_KEY: "" } });
    assert.equal(readCustomProviders(environment)[0].enabled, false);
    await changeCustomProvider("remove", { id: created.id }, { environment });
    assert.deepEqual(readCustomProviders(environment), []);
    assert.equal(JSON.parse(await readFile(path.join(directory, "torrent-providers.json"), "utf8")).legacyJackettMigrated, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
