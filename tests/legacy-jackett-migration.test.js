import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { changeCustomProvider, readCustomProviders } from "../lib/settings/torrent-providers.js";
import { configuredProviders } from "../lib/search/provider.js";

test("legacy Jackett settings convert once to scoped custom Torznab sources", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "torplay-jackett-migration-"));
  const environment = { TORPLAY_CONFIG_PATH: path.join(directory, "torplay.env"),
    JACKETT_URL: "http://localhost:9117", JACKETT_API_KEY: "private-key",
    JACKETT_MOVIE_INDEXERS: "movies", JACKETT_SHOW_INDEXERS: "shows",
    TORPLAY_SEARCH_PROVIDERS: "jackett" };
  try {
    const first = readCustomProviders(environment);
    assert.equal(first.length, 2);
    assert.deepEqual(first.find((item) => item.name === "Jackett (movies)").searchMediaTypes, ["Movies"]);
    assert.deepEqual(first.find((item) => item.name === "Jackett (shows)").searchMediaTypes, ["TV"]);
    assert.deepEqual(configuredProviders(environment).map((item) => item.id), first.map((item) => item.id));
    const filename = path.join(directory, "torrent-providers.json");
    const saved = await readFile(filename, "utf8");
    assert.equal(saved.includes("private-key"), false);
    assert.equal(JSON.parse(saved).legacyJackettMigrated, true);
    assert.deepEqual(first.map((item) => item.kind), ["jackett", "jackett"]);
    assert.deepEqual(readCustomProviders(environment).map((item) => item.id), first.map((item) => item.id));
    assert.equal(await readFile(filename, "utf8"), saved);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("removing the final migrated Jackett source does not recreate it", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "torplay-jackett-empty-"));
  const environment = { TORPLAY_CONFIG_PATH: path.join(directory, "torplay.env"),
    JACKETT_URL: "http://localhost:9117", JACKETT_API_KEY: "private-key",
    JACKETT_MOVIE_INDEXERS: "movies" };
  try {
    const migrated = readCustomProviders(environment);
    for (const provider of migrated) await changeCustomProvider("remove", { id: provider.id }, { environment });
    assert.deepEqual(readCustomProviders(environment), []);
    const saved = JSON.parse(await readFile(path.join(directory, "torrent-providers.json"), "utf8"));
    assert.equal(saved.legacyJackettMigrated, true);
    assert.deepEqual(saved.providers, []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("legacy conversion does not overwrite an invalid existing provider file", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "torplay-jackett-preserve-"));
  const filename = path.join(directory, "torrent-providers.json");
  const environment = { TORPLAY_CONFIG_PATH: path.join(directory, "torplay.env"),
    JACKETT_URL: "http://localhost:9117", JACKETT_API_KEY: "private-key" };
  try {
    await writeFile(filename, '[{"broken":true}]');
    assert.throws(() => readCustomProviders(environment), /could not be read/);
    assert.equal(await readFile(filename, "utf8"), '[{"broken":true}]');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("an existing empty provider file is not repopulated from old lists", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "torplay-jackett-idempotent-"));
  const filename = path.join(directory, "torrent-providers.json");
  const environment = { TORPLAY_CONFIG_PATH: path.join(directory, "torplay.env"),
    JACKETT_URL: "http://localhost:9117", JACKETT_API_KEY: "private-key", JACKETT_MOVIE_INDEXERS: "movies" };
  try {
    await writeFile(filename, "[]");
    assert.deepEqual(readCustomProviders(environment), []);
    assert.equal(JSON.parse(await readFile(filename, "utf8")).legacyJackettMigrated, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("an edited legacy source is not duplicated during migration", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "torplay-jackett-edited-"));
  const filename = path.join(directory, "torrent-providers.json");
  const endpoint = "http://localhost:9117/api/v2.0/indexers/movies/results/torznab/api";
  const id = `custom-${createHash("sha256").update(`legacy-jackett:${endpoint}`).digest("hex").slice(0, 24)}`;
  const environment = { TORPLAY_CONFIG_PATH: path.join(directory, "torplay.env"),
    JACKETT_URL: "http://localhost:9117", JACKETT_API_KEY: "private-key", JACKETT_MOVIE_INDEXERS: "movies" };
  try {
    await writeFile(filename, JSON.stringify([{ id, name: "Jackett (movies)", endpoint, apiKey: "private-key", enabled: true,
      capabilities: { mediaTypes: ["Movies"], modes: { search: ["q"], movie: ["q"] } } }]));
    const providers = readCustomProviders(environment);
    assert.equal(providers.filter((item) => item.id === id).length, 1);
    assert.equal(providers.length, 2); // The old empty TV list still maps to "all" once.
  } finally { await rm(directory, { recursive: true, force: true }); }
});
