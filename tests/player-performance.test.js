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

test("automatic segment actions wait for the visible countdown", async () => {
  const source = await readFile(new URL("../components/VideoPlayer.js", import.meta.url), "utf8");
  assert.match(source, /setTimeout\(\(\) => \{[\s\S]*autoSkipSegment\(segment\);[\s\S]*AUTOMATIC_SEGMENT_DELAY_SECONDS \* 1000/);
  assert.match(source, /let remaining = AUTOMATIC_SEGMENT_DELAY_SECONDS/);
  assert.match(source, /automaticOutroPrompt = showEpisodePrompt && nextEpisodePrompt\?\.kind === "ready"/);
  assert.doesNotMatch(source, /!playbackPreferences\.autoPlayNextEpisode \|\| !automaticSegment\(currentSegments\.outro\)/);
  assert.match(source, /completeEpisodeAtOutro\(\)/);
  assert.match(source, /void saveProgress\(\{ position: timeline\.duration, duration: timeline\.duration \}\)/);
  assert.match(source, /nextEpisodePrompt\?\.kind === "ready"[\s\S]*nextEpisodePrompt\.onAction\(\)/);
  assert.match(source, /playerAutomaticProgress/);
});
