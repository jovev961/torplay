import assert from "node:assert/strict";
import test from "node:test";
import {
  PREFETCH_MAX_BYTES,
  publicPrefetchStatus,
} from "../lib/playback/prefetch.js";

test("uses a bounded startup buffer without waiting for a media probe", () => {
  assert.equal(PREFETCH_MAX_BYTES, 64 * 1024 * 1024);
});

test("returns a stable public prefetch status", () => {
  assert.deepEqual(publicPrefetchStatus({
    state: "preparing", fileId: "2", targetBytes: 100, downloadedBytes: 20,
  }), {
    state: "preparing", fileId: "2", targetBytes: 100, downloadedBytes: 20,
  });
});
