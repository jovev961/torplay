import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GET } from "../app/api/search/route.js";

test("search returns a stable configuration prompt when no torrent source is enabled", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "torplay-empty-search-"));
  const keys = [
    "TORPLAY_CONFIG_PATH",
    "TORPLAY_SEARCH_PROVIDERS",
    "JACKETT_URL",
    "JACKETT_API_KEY",
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.TORPLAY_CONFIG_PATH = path.join(directory, "torplay.env");
  delete process.env.TORPLAY_SEARCH_PROVIDERS;
  delete process.env.JACKETT_URL;
  delete process.env.JACKETT_API_KEY;
  try {
    const response = await GET(new Request("http://localhost/api/search?q=Sintel&type=movie"));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: "Add a torrent source in Settings before searching.",
      code: "NO_TORRENT_SOURCES",
    });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
