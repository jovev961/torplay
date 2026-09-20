import assert from "node:assert/strict";
import test from "node:test";
import { SETTINGS_SECTIONS, settingsSectionFromHash } from "../lib/settings/navigation.js";

test("settings navigation exposes every category and selects one valid hash", () => {
  assert.deepEqual(SETTINGS_SECTIONS.map(([id]) => id), [
    "general",
    "services",
    "torrent-sources",
    "subtitles",
    "playback",
    "about",
  ]);
  assert.equal(settingsSectionFromHash("#torrent-sources"), "torrent-sources");
  assert.equal(settingsSectionFromHash("about"), "about");
});

test("settings navigation falls back to General for missing or unknown hashes", () => {
  assert.equal(settingsSectionFromHash(""), "general");
  assert.equal(settingsSectionFromHash("#unknown"), "general");
});
