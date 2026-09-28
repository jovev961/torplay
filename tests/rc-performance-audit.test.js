import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { directoryStats, measureRoute, median } from "../scripts/audit-rc-performance.js";

test("RC audit reports stable medians", () => {
  assert.equal(median([9, 2, 5, 3, 7]), 5);
  assert.equal(median([2, 4]), 3);
  assert.equal(median([]), null);
});

test("RC audit measures complete responses", async () => {
  const result = await measureRoute("http://torplay.test", "/api/health", 3, async () => (
    new Response('{"ok":true}', { status: 200 })
  ));
  assert.equal(result.status, 200);
  assert.equal(result.bytes, 11);
  assert.equal(result.samplesMs.length, 3);
  assert.equal(Number.isFinite(result.medianMs), true);
});

test("RC audit counts runtime files without following symlinks", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "torplay-rc-audit-"));
  try {
    await mkdir(path.join(directory, "nested"));
    await writeFile(path.join(directory, "one"), "1234");
    await writeFile(path.join(directory, "nested", "two"), "12");
    assert.deepEqual(await directoryStats(directory), { bytes: 6, files: 2 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
