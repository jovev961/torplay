import assert from "node:assert/strict";
import test from "node:test";
import {
  applySubtitleCuePosition,
  normalizeSubtitleAppearance,
  readSubtitleAppearance,
  SUBTITLE_APPEARANCE_DEFAULTS,
  SUBTITLE_APPEARANCE_STORAGE_KEY,
  subtitleAppearanceClassName,
  writeSubtitleAppearance,
} from "../lib/subtitles/appearance.js";

test("normalizes subtitle appearance field by field", () => {
  assert.deepEqual(normalizeSubtitleAppearance(null), SUBTITLE_APPEARANCE_DEFAULTS);
  assert.deepEqual(normalizeSubtitleAppearance({
    version: 99,
    size: "large",
    font: "comic-sans",
    textColor: "yellow",
    edgeStyle: "outline",
    backgroundOpacity: "25",
    bottomOffsetPercent: 35,
  }), {
    version: 1,
    size: "large",
    font: "sans",
    textColor: "yellow",
    edgeStyle: "outline",
    backgroundOpacity: 25,
    bottomOffsetPercent: 35,
  });
});

test("reads, writes, and safely recovers device subtitle preferences", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const written = writeSubtitleAppearance(storage, { size: "extra-large", backgroundOpacity: 0 });
  assert.equal(written.size, "extra-large");
  assert.equal(written.backgroundOpacity, 0);
  assert.deepEqual(readSubtitleAppearance(storage), written);
  assert.ok(values.has(SUBTITLE_APPEARANCE_STORAGE_KEY));

  values.set(SUBTITLE_APPEARANCE_STORAGE_KEY, "not json");
  assert.deepEqual(readSubtitleAppearance(storage), SUBTITLE_APPEARANCE_DEFAULTS);
  assert.deepEqual(readSubtitleAppearance({ getItem: () => { throw new Error("blocked"); } }), SUBTITLE_APPEARANCE_DEFAULTS);
  assert.doesNotThrow(() => writeSubtitleAppearance({ setItem: () => { throw new Error("full"); } }, written));
});

test("builds only validated subtitle appearance class names", () => {
  assert.equal(
    subtitleAppearanceClassName({
      size: "small",
      font: "serif",
      textColor: "cyan",
      edgeStyle: "none",
      backgroundOpacity: 100,
    }),
    "subtitle-size-small subtitle-font-serif subtitle-color-cyan subtitle-edge-none subtitle-background-100",
  );
});

test("positions WebVTT cues by percentage with safe feature detection", () => {
  const completeCue = { line: "auto", lineAlign: "start", snapToLines: true };
  const basicCue = { line: "auto", snapToLines: true };
  const ignoredCue = { text: "not a VTTCue" };
  const count = applySubtitleCuePosition({ cues: [completeCue, basicCue, ignoredCue] }, 25);
  assert.equal(count, 2);
  assert.deepEqual(completeCue, { line: 75, lineAlign: "end", snapToLines: false });
  assert.deepEqual(basicCue, { line: 75, snapToLines: false });
  assert.deepEqual(ignoredCue, { text: "not a VTTCue" });

  applySubtitleCuePosition({ cues: [completeCue] }, 999);
  assert.equal(completeCue.line, 90);
});
