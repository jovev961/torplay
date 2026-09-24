import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDatabase } from "../lib/database/sqlite.js";
import { autoMapEpisodeFiles, episodeMappingsForFiles, mappedEpisodeFile, resolveEpisodeFile,
  saveEpisodeFileMapping } from "../lib/video/episode-mapping.js";

const hashA = "a".repeat(40);
const hashB = "b".repeat(40);
const context = { type: "show", tmdbId: 99, season: 1, episode: 1 };

test("manual episode mapping uses torrent hash and stable file path, then survives database reopen", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "torplay-episode-map-"));
  const filename = path.join(directory, "state.db");
  let db = createDatabase(filename);
  try {
    const files = [
      { id: "0", name: "OP-1.mkv", relativePath: "Season/OP-1.mkv", size: 1000 },
      { id: "1", name: "OP-2.mkv", relativePath: "Season/OP-2.mkv", size: 1000 },
    ];
    assert.equal(resolveEpisodeFile(hashA, context, files, 1, 1, { database: db }), null);
    saveEpisodeFileMapping(hashA, context, files[0], db);
    assert.equal(resolveEpisodeFile(hashA, context, files, 1, 1, { database: db })?.id, "0");
    db.close();
    db = createDatabase(filename);
    assert.equal(mappedEpisodeFile(hashA, context, files, 1, 1, db)?.id, "0");
    assert.equal(mappedEpisodeFile(hashB, context, files, 1, 1, db), null);
    assert.equal(mappedEpisodeFile(hashA, { ...context, tmdbId: 100 }, files, 1, 1, db), null);
    assert.equal(mappedEpisodeFile(hashA, context, [
      { ...files[0], id: "7", relativePath: "Moved/OP-1.mkv" },
    ], 1, 1, db)?.id, "7");
    assert.equal(mappedEpisodeFile(hashA, context, [
      { ...files[0], id: "7", relativePath: "Moved/OP-1.mkv" },
      { ...files[0], id: "8", relativePath: "Other/OP-1.mkv" },
    ], 1, 1, db), null);
    assert.equal(mappedEpisodeFile(hashA, context, [{ ...files[0], size: 1001 }], 1, 1, db), null);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("filename and TMDB episode-title mappings stay conservative and preserve manual choices", () => {
  const db = createDatabase(":memory:");
  const files = [
    { providerId: "1", name: "Example.S01E01.mkv", path: "Pack/Example.S01E01.mkv", size: 1000 },
    { providerId: "2", name: "Example.S01E02.mkv", path: "Pack/Example.S01E02.mkv", size: 1000 },
    { providerId: "3", name: "The Hidden Forest.mkv", path: "Pack/The Hidden Forest.mkv", size: 1000 },
    { providerId: "4", name: "The Hidden Forest copy.mkv", path: "Pack/The Hidden Forest copy.mkv", size: 1000 },
    { providerId: "5", name: "OP-4.mkv", path: "Pack/OP-4.mkv", size: 1000 },
  ];
  try {
    saveEpisodeFileMapping(hashA, { ...context, episode: 2 }, files[4], db);
    autoMapEpisodeFiles(hashA, context, files, [
      { number: 3, title: "The Hidden Forest" },
      { number: 4, title: "Pilot" },
    ], db);
    assert.equal(resolveEpisodeFile(hashA, context, files, 1, 1, { database: db })?.providerId, "1");
    assert.equal(resolveEpisodeFile(hashA, context, files, 1, 2, { database: db })?.providerId, "5");
    assert.equal(resolveEpisodeFile(hashA, context, files, 1, 3, { database: db }), null);
    assert.equal(resolveEpisodeFile(hashA, context, files, 1, 4, { database: db }), null);
    assert.deepEqual(episodeMappingsForFiles(hashA, context, files, db)
      .map((entry) => [entry.episode, entry.source]), [[1, "filename-match"], [2, "manual"]]);
    autoMapEpisodeFiles(hashB, context, [files[2]], [{ number: 3, title: "The Hidden Forest" }], db);
    assert.equal(resolveEpisodeFile(hashB, context, [files[2]], 1, 3, { database: db })?.providerId, "3");
    assert.equal(episodeMappingsForFiles(hashB, context, [files[2]], db)[0].source, "episode-list");
  } finally { db.close(); }
});
