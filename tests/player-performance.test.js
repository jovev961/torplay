import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("HLS demuxing stays off the UI thread", async () => {
  const source = await readFile(new URL("../components/VideoPlayer.js", import.meta.url), "utf8");
  const start = source.indexOf("const hls = new Hls({");
  const end = source.indexOf("});", start);

  assert.notEqual(start, -1);
  assert.match(source.slice(start, end), /enableWorker:\s*true/);
});
