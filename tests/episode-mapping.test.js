import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDatabase } from "../lib/database/sqlite.js";
import { mappedEpisodeFile, resolveEpisodeFile, saveEpisodeFileMapping } from "../lib/video/episode-mapping.js";

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
