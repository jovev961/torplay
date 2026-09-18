import assert from "node:assert/strict";
import test from "node:test";
import {
  activeSubtitleCues,
  subscribeToSubtitleTrack,
} from "../lib/subtitles/timeline.js";

const cues = [
  { startTime: 5, endTime: 7, text: "Opening" },
  { startTime: 1_215, endTime: 1_218, text: "Twenty minutes" },
  { startTime: 1_500, endTime: 1_503, text: "Later" },
];

function activeText(position, delay = 0) {
  return activeSubtitleCues(cues, position, delay).map((cue) => cue.text);
}

test("selects cues from the absolute media timeline at start and resume", () => {
  assert.deepEqual(activeText(5), ["Opening"]);
  assert.deepEqual(activeText(1_215), ["Twenty minutes"]);
  assert.deepEqual(activeText(1_200), []);
});

test("forward, backward, and repeated seeks do not accumulate subtitle drift", () => {
  const positions = [1_215, 1_500, 6, 1_215, 900, 1_500, 1_215];
  assert.deepEqual(positions.map((position) => activeText(position)), [
    ["Twenty minutes"],
    ["Later"],
    ["Opening"],
    ["Twenty minutes"],
    [],
    ["Later"],
    ["Twenty minutes"],
  ]);
});

test("manual delay changes lookup time without mutating cue timestamps", () => {
  assert.deepEqual(activeText(1_215.5, 0.5), ["Twenty minutes"]);
  assert.deepEqual(activeText(1_214.5, -0.5), ["Twenty minutes"]);
  assert.deepEqual(cues[1], {
    startTime: 1_215,
    endTime: 1_218,
    text: "Twenty minutes",
  });
});

test("track switching and Off/on choices reuse the same absolute timeline", () => {
  const alternate = [{ startTime: 1_215, endTime: 1_218, text: "Alternate language" }];
  assert.deepEqual(activeText(1_215), ["Twenty minutes"]);
  assert.deepEqual(activeSubtitleCues(alternate, 1_215).map((cue) => cue.text), ["Alternate language"]);
  assert.deepEqual(activeSubtitleCues([], 1_215), []);
  assert.deepEqual(activeText(1_215), ["Twenty minutes"]);
});

test("ignores invalid cues and supports simultaneous caption lines", () => {
  const active = activeSubtitleCues([
    { startTime: 10, endTime: 12, text: "First" },
    { startTime: 10.5, endTime: 11.5, text: "Second" },
    { startTime: 11, endTime: 11, text: "Empty" },
    { startTime: "invalid", endTime: 12, text: "Invalid" },
  ], 11);
  assert.deepEqual(active.map((cue) => cue.text), ["First", "Second"]);
});

function fakeTrackElement(readyState = 0) {
  const listeners = new Map();
  return {
    readyState,
    track: { mode: "disabled", cues: [{ startTime: 1, endTime: 2, text: "Loaded" }] },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
    dispatch(type) {
      listeners.get(type)?.();
    },
    hasListener(type) {
      return listeners.has(type);
    },
  };
}

test("reads cues immediately when the browser load event was already missed", () => {
  const element = fakeTrackElement(2);
  let loaded = [];
  const unsubscribe = subscribeToSubtitleTrack(element, {
    mode: "hidden",
    onCues: (cues) => { loaded = cues; },
  });

  assert.equal(element.track.mode, "hidden");
  assert.deepEqual(loaded.map((cue) => cue.text), ["Loaded"]);
  unsubscribe();
  assert.equal(element.hasListener("load"), false);
});

test("observes later native track load and error events", () => {
  const element = fakeTrackElement();
  let loads = 0;
  let errors = 0;
  const unsubscribe = subscribeToSubtitleTrack(element, {
    onCues: () => { loads += 1; },
    onError: () => { errors += 1; },
  });

  element.dispatch("load");
  element.dispatch("error");
  assert.equal(loads, 1);
  assert.equal(errors, 1);
  unsubscribe();
  element.dispatch("load");
  assert.equal(loads, 1);
});
