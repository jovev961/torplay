import assert from "node:assert/strict";
import test from "node:test";
import { createDatabase } from "../lib/database/sqlite.js";
import { inspectTorrentAvailability } from "../lib/debrid/availability.js";
import { saveSearchResult } from "../lib/search/result-store.js";

const firstHash = "a".repeat(40);
const secondHash = "b".repeat(40);
const context = { type: "show", tmdbId: 123, season: 1, episode: 2 };
const config = { mode: "prefer-debrid", localFallback: true,
  priority: ["real-debrid", "torbox"],
  credentials: { "real-debrid": { apiKey: "test" }, torbox: { apiKey: "test" } } };

test("torrent list checks both providers and the requested episode without starting playback", async () => {
  const database = createDatabase(":memory:");
  const first = saveSearchResult({ infoHash: firstHash, mediaContext: context });
  const second = saveSearchResult({ infoHash: secondHash, mediaContext: context });
  const calls = { rd: 0, tb: 0 };
  try {
    const result = await inspectTorrentAvailability([first, second], {}, {
      config, database,
      providerFactory: (id) => id === "real-debrid" ? {
        async checkAvailabilityMany(hashes) {
          calls.rd += 1;
          assert.deepEqual(hashes, [firstHash, secondHash]);
          return {
            [firstHash]: { status: "available", files: [{ name: "Show.S01E02.mkv", path: "Show.S01E02.mkv", size: 1000 }] },
            [secondHash]: { status: "available", files: [{ name: "Show.S01E03.mkv", path: "Show.S01E03.mkv", size: 1000 }] },
          };
        },
      } : {
        async checkAvailability({ infoHash }) {
          calls.tb += 1;
          if (infoHash === secondHash) throw new Error("Provider unavailable");
          return { status: "miss" };
        },
      },
    });
    assert.deepEqual(result.providers, ["real-debrid", "torbox"]);
    assert.deepEqual(result.results[first].availability,
      { "real-debrid": "ready", torbox: "not-ready" });
    assert.deepEqual(result.results[second].availability,
      { "real-debrid": "not-ready", torbox: "unknown" });
    assert.deepEqual(calls, { rd: 1, tb: 2 });
  } finally { database.close(); }
});

test("selecting a torrent re-resolves its hash before showing provider readiness", async () => {
  const database = createDatabase(":memory:");
  const resultId = saveSearchResult({ infoHash: firstHash, mediaContext: context });
  try {
    const result = await inspectTorrentAvailability([resultId], { resolveUnknown: true }, {
      config: { ...config, credentials: { torbox: config.credentials.torbox } }, database,
      resolveSource: async () => ({ infoHash: secondHash }),
      providerFactory: () => ({
        async checkAvailability({ infoHash }) {
          assert.equal(infoHash, secondHash);
          return { status: "available", files: [{ name: "Show.S01E02.mkv", path: "Show.S01E02.mkv", size: 1000 }] };
        },
      }),
    });
    assert.equal(result.results[resultId].availability.torbox, "ready");
  } finally { database.close(); }
});

test("expired and excessive result selections are rejected", async () => {
  await assert.rejects(inspectTorrentAvailability(["expired"]), { status: 404 });
  await assert.rejects(inspectTorrentAvailability(Array(21).fill("same")), { status: 400 });
});
