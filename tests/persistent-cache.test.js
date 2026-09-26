import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readPersistentCache, writePersistentCache } from "../lib/cache/persistent.js";
import { createDatabase } from "../lib/database/sqlite.js";

test("persistent cache survives database reopen and expires entries", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "torplay-cache-"));
  const filename = path.join(directory, "cache.db");
  let database = createDatabase(filename);
  try {
    assert.equal(writePersistentCache("metadata", "movie:1", { title: "Sintel" }, {
      database,
      now: 1_000,
      ttlMs: 5_000,
    }), true);
    database.close();
    database = createDatabase(filename);
    assert.deepEqual(readPersistentCache("metadata", "movie:1", { database, now: 5_999 }), {
      hit: true,
      value: { title: "Sintel" },
      createdAt: 1_000,
      expiresAt: 6_000,
    });
    assert.deepEqual(readPersistentCache("metadata", "movie:1", { database, now: 6_000 }), {
      hit: false,
      value: null,
    });
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM external_response_cache").get().count, 0);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("persistent cache corruption and storage failures degrade to a cache miss", () => {
  const database = createDatabase(":memory:");
  try {
    database.prepare(`
      INSERT INTO external_response_cache (namespace, cache_key, value_json, expires_at, created_at)
      VALUES ('metadata', 'broken', '{', 10000, 1000)
    `).run();
    assert.deepEqual(readPersistentCache("metadata", "broken", { database, now: 2_000 }), {
      hit: false,
      value: null,
    });
  } finally {
    database.close();
  }

  const unavailable = { prepare() { throw new Error("storage offline"); } };
  assert.deepEqual(readPersistentCache("metadata", "movie:1", { database: unavailable }), {
    hit: false,
    value: null,
  });
  assert.equal(writePersistentCache("metadata", "movie:1", {}, {
    database: unavailable,
    ttlMs: 1_000,
  }), false);
});
