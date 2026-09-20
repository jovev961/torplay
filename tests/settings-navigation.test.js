import assert from "node:assert/strict";
import test from "node:test";
import {
  SETTINGS_SECTIONS,
  settingsSectionFromHash,
  settingsValidationRequest,
} from "../lib/settings/navigation.js";

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

test("validates external services only when their settings section is viewed", () => {
  const snapshot = {
    providers: [
      { id: "tmdb", section: "services" },
      { id: "opensubtitles", section: "subtitles" },
    ],
    torrentSources: {
      providers: [
        { id: "knaben", enabled: true },
        { id: "yts", enabled: false },
      ],
    },
  };

  assert.deepEqual(settingsValidationRequest(snapshot, "general"), {
    providerIds: [], native: false,
  });
  assert.deepEqual(settingsValidationRequest(snapshot, "services"), {
    providerIds: ["tmdb"], native: false,
  });
  assert.deepEqual(settingsValidationRequest(snapshot, "torrent-sources"), {
    providerIds: ["knaben"], native: true,
  });
  assert.deepEqual(settingsValidationRequest(snapshot, "subtitles"), {
    providerIds: ["opensubtitles"], native: false,
  });
});
