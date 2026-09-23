import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readCustomProviders } from "../lib/settings/torrent-providers.js";
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
    assert.equal(saved.includes("private-key"), true);
    assert.deepEqual(readCustomProviders(environment).map((item) => item.id), first.map((item) => item.id));
    assert.equal(await readFile(filename, "utf8"), saved);
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
