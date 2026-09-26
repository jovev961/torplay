import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GET } from "../app/api/profiles/[id]/recommendations/route.js";
import { closeDatabases, getDatabase } from "../lib/database/sqlite.js";
import { createProfile } from "../lib/profiles/service.js";

test("recommendations route returns profile-specific empty state and validates mode", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "torplay-recommendations-route-"));
  const previousPath = process.env.TORPLAY_DATABASE_PATH;
  process.env.TORPLAY_DATABASE_PATH = path.join(directory, "history.db");
  try {
    const profile = createProfile({ name: "Viewer" }, getDatabase());
    const context = { params: Promise.resolve({ id: profile.id }) };
    const response = await GET(new Request("http://localhost/api/profiles/id/recommendations"), context);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { mode: "recent", seedCount: 0, results: [], partial: false });

    const invalid = await GET(new Request("http://localhost/api/profiles/id/recommendations?mode=other"), context);
    assert.equal(invalid.status, 400);
    assert.equal(invalid.headers.get("cache-control"), "no-store");

    const missing = await GET(new Request("http://localhost/api/profiles/id/recommendations"), {
      params: Promise.resolve({ id: "missing" }),
    });
    assert.equal(missing.status, 404);
  } finally {
    closeDatabases();
    if (previousPath === undefined) delete process.env.TORPLAY_DATABASE_PATH;
    else process.env.TORPLAY_DATABASE_PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
});
