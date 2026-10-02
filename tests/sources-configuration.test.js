import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { stringify } from "yaml";
import { configuredSources, configure, readConfiguration, sourceSnapshot, sourceHealth, verifySource } from "../lib/sources/configuration.js";
import { importDefinition } from "../lib/sources/cardigann/definition.js";
import { search } from "../lib/sources/discovery.js";
import { NetworkError } from "../lib/network/request.js";
import { definition, response, settingsFixture, torznab, movie } from "./helpers/sources-fixtures.js";

test("fresh installation exposes optional integrations but configures and contacts none", async (t) => {
  const { environment } = await settingsFixture(t);
  assert.deepEqual(configuredSources(environment), []);
  const snapshot = sourceSnapshot(environment, true);
  assert.equal(snapshot.nativeSources.length, 3);
  assert.ok(snapshot.nativeSources.every((source) => !source.configured && !source.enabled && !source.active));
  let contacted = 0;
  await assert.rejects(search(movie, { environment, request: () => { contacted++; } }), { code: "NO_TORRENT_SOURCES" });
  assert.equal(contacted, 0);
});

test("native configuration is disabled until explicitly enabled and remove persists", async (t) => {
  const { environment } = await settingsFixture(t);
  await configure("add-native", { id: "yts" }, { environment });
  assert.equal(sourceSnapshot(environment).nativeSources.find((s) => s.id === "yts").configured, true);
  assert.deepEqual(configuredSources(environment), []);
  await configure("update-native", { id: "yts", enabled: true }, { environment });
  assert.deepEqual(configuredSources(environment).map((s) => s.id), ["yts"]);
  await configure("update-native", { id: "yts", enabled: false }, { environment });
  assert.deepEqual(configuredSources(environment), []);
  await configure("remove-native", { id: "yts" }, { environment });
  assert.equal(sourceSnapshot(environment).nativeSources.find((s) => s.id === "yts").configured, false);
});

test("custom configure, enable and removal are distinct and credentials stay private", async (t) => {
  const { environment } = await settingsFixture(t);
  const result = await configure("create", { name: "Personal", endpoint: "https://personal.example/api", apiKey: "private-fixture-key" }, { environment });
  const source = result.providers[0];
  assert.equal(source.enabled, false);
  assert.equal(source.apiKeyConfigured, true);
  assert.ok(!JSON.stringify(result).includes("private-fixture-key"));
  await configure("set-enabled", { id: source.id, enabled: true }, { environment });
  assert.equal(configuredSources(environment)[0].apiKey, "private-fixture-key");
  await configure("remove", { id: source.id }, { environment });
  assert.deepEqual(readConfiguration(environment).custom, []);
});

test("legacy native and Torznab records survive an upgrade and unrelated write", async (t) => {
  const fixture = await settingsFixture(t);
  await fixture.write("native-sources.json", [{ id: "knaben", enabled: true }]);
  await fixture.write("torrent-providers.json", [torznab("saved")]);
  assert.deepEqual(configuredSources(fixture.environment).map((s) => s.id), ["knaben", "saved"]);
  await configure("add-native", { id: "eztv" }, { environment: fixture.environment });
  const stored = JSON.parse(await readFile(path.join(fixture.directory, "torrent-providers.json"), "utf8"));
  assert.equal(stored.version, 2);
  assert.equal(stored.providers[0].apiKey, "synthetic-secret");
  assert.equal(stored.providers[0].enabled, true);
  assert.equal(configuredSources(fixture.environment).length, 2);
});

test("explicit legacy indexer selections migrate without enabling an unconfigured service", async (t) => {
  const fixture = await settingsFixture(t, { JACKETT_URL: "http://127.0.0.1:9117", JACKETT_API_KEY: "fixture-key",
    JACKETT_MOVIE_INDEXERS: "movies", JACKETT_SHOW_INDEXERS: "shows" });
  const before = configuredSources(fixture.environment);
  assert.deepEqual(before.map((s) => s.indexerId), ["movies", "shows"]);
  assert.deepEqual(before.map((s) => s.searchMediaTypes), [["Movies"], ["TV"]]);
  await configure("add-native", { id: "yts" }, { environment: fixture.environment });
  assert.deepEqual(configuredSources(fixture.environment).map((s) => s.id), before.map((s) => s.id));
  const empty = await settingsFixture(t, { JACKETT_URL: "http://127.0.0.1:9117", JACKETT_API_KEY: "fixture-key" });
  assert.deepEqual(configuredSources(empty.environment), []);
});

test("unrepresentable saved records are surfaced and retained", async (t) => {
  const fixture = await settingsFixture(t);
  const invalid = { id: "retained", name: "Saved", enabled: true, kind: "torznab", endpoint: "file:///private", apiKey: "fixture" };
  await fixture.write("torrent-providers.json", [invalid]);
  assert.equal(sourceSnapshot(fixture.environment).customProviders[0].configuration.status, "configuration-required");
  await configure("add-native", { id: "yts" }, { environment: fixture.environment });
  assert.equal(readConfiguration(fixture.environment).custom[0].endpoint, invalid.endpoint);
});

test("malformed configuration and duplicate identities fail explicitly", async (t) => {
  const fixture = await settingsFixture(t);
  await fixture.write("torrent-providers.json", [torznab("same"), torznab("same")]);
  assert.throws(() => readConfiguration(fixture.environment), { code: "CONFIGURATION_REQUIRED" });
  await fixture.write("torrent-providers.json", { version: 99, providers: [] });
  assert.throws(() => readConfiguration(fixture.environment), { code: "CONFIGURATION_REQUIRED" });
});

test("compatible Cardigann definition imports without contacting its unavailable endpoint", async (t) => {
  const fixture = await settingsFixture(t);
  const requested = [];
  const imported = await importDefinition("https://definitions.example/source.yml", { request: async (url) => {
    requested.push(url.href); return response(stringify(definition()), url);
  } });
  const result = await configure("create-cardigann", { importId: imported.importId }, { environment: fixture.environment });
  assert.deepEqual(requested, ["https://definitions.example/source.yml"]);
  assert.equal(result.providers[0].enabled, false);
  assert.equal(result.providers[0].compatibility.supported, true);
  assert.equal(result.providers[0].verification.status, "unverified");
  assert.equal(result.providers[0].configuration.status, "ready");
});

test("verification failure preserves enabled state and unrelated source configuration", async (t) => {
  const fixture = await settingsFixture(t);
  const imported = await importDefinition("https://definitions.example/source.yml", { request: async (url) => response(stringify(definition()), url) });
  const added = await configure("create-cardigann", { importId: imported.importId, enabled: true }, { environment: fixture.environment });
  await configure("create", { name: "Unrelated", endpoint: "https://another.example/api", apiKey: "unchanged-key", enabled: true }, { environment: fixture.environment });
  const result = await configure("test-cardigann", { id: added.providers[0].id }, { environment: fixture.environment,
    request: async () => { throw new NetworkError("REMOTE_CONNECTION_FAILED", "Synthetic connection failure."); } });
  assert.equal(result.verification.status, "unavailable");
  assert.ok(!JSON.stringify(result).includes("do-not-show"));
  const stored = readConfiguration(fixture.environment).custom;
  assert.ok(stored.every((s) => s.enabled));
  assert.equal(stored.find((s) => s.name === "Unrelated").apiKey, "unchanged-key");
});

test("configuration, compatibility and solver readiness are independent of verification", async (t) => {
  const fixture = await settingsFixture(t);
  const def = definition({ settings: [{ name: "solver", type: "info_flaresolverr", label: "Solver" }] });
  const imported = await importDefinition("https://definitions.example/solver.yml", { request: async (url) => response(stringify(def), url) });
  const result = await configure("create-cardigann", { importId: imported.importId }, { environment: fixture.environment });
  assert.equal(result.providers[0].compatibility.supported, true);
  assert.equal(result.providers[0].configuration.status, "requires-flaresolverr");
  assert.equal(result.providers[0].verification.status, "unverified");
});

test("disabled health checks make no requests and selection exclusions stay disabled", async (t) => {
  const fixture = await settingsFixture(t, { TORPLAY_SEARCH_PROVIDERS: "" });
  await configure("add-native", { id: "yts", enabled: true }, { environment: fixture.environment });
  assert.deepEqual(configuredSources(fixture.environment), []);
  assert.equal((await sourceHealth({ environment: fixture.environment }))[0].status, "disabled");
});

test("concurrent source configuration writes preserve both user actions", async (t) => {
  const { environment } = await settingsFixture(t);
  await Promise.all([configure("add-native", { id: "yts", enabled: true }, { environment }),
    configure("add-native", { id: "knaben", enabled: true }, { environment })]);
  assert.deepEqual(configuredSources(environment).map((source) => source.id).sort(), ["knaben", "yts"]);
});

test("source verification rejects pre-cancellation without network work", async () => {
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  await assert.rejects(verifySource(torznab(), { signal: controller.signal, request: async () => { calls++; } }), { name: "AbortError" });
  assert.equal(calls, 0);
});
