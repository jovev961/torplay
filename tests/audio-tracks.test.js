import assert from "node:assert/strict";
import test from "node:test";
import {
  audioTrackByIndex,
  normalizeAudioLanguage,
  normalizeAudioPreference,
  selectAudioTrack,
} from "../lib/video/audio-tracks.js";

test("normalizes common FFprobe ISO 639 aliases", () => {
  assert.equal(normalizeAudioLanguage("eng"), "en");
  assert.equal(normalizeAudioLanguage("mkd"), "mk");
  assert.equal(normalizeAudioLanguage("mac"), "mk");
  assert.equal(normalizeAudioLanguage("ger"), "de");
  assert.equal(normalizeAudioLanguage(""), "und");
  assert.equal(normalizeAudioPreference("ORIGINAL"), "original");
  assert.throws(() => normalizeAudioPreference("not-a-language"), /valid preferred/);
});

test("selects preferred normal audio without automatically choosing special tracks", () => {
  const tracks = [
    { index: 1, language: "en", default: false, commentary: true },
    { index: 2, language: "mk", default: false },
    { index: 3, language: "mk", default: true },
    { index: 4, language: "en", default: true },
  ];
  assert.equal(selectAudioTrack(tracks, "mk").index, 3);
  assert.equal(selectAudioTrack(tracks, "fr").index, 3);
  assert.equal(selectAudioTrack(tracks, "original").index, 3);
  assert.equal(audioTrackByIndex(tracks, 2).language, "mk");
  assert.equal(audioTrackByIndex(tracks, 99), null);
});
