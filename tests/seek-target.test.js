import assert from "node:assert/strict";
import test from "node:test";
import { clampSeekTarget, localSeekPosition, seekHasArrived, skipTarget } from "../lib/video/seek-target.js";

function ranges(values) {
  return {
    length: values.length,
    start: (index) => values[index][0],
    end: (index) => values[index][1],
  };
}

test("rapid skips accumulate from the requested point while playback catches up", () => {
  const first = skipTarget(60, null, 10, 120);
  const second = skipTarget(60, first, 10, 120);
  const third = skipTarget(60, second, 10, 120);
  assert.deepEqual([first, second, third], [70, 80, 90]);
  assert.equal(seekHasArrived(60, third), false);
  assert.equal(seekHasArrived(90, third), true);
});

test("backward skip and explicit seek reach zero rather than the stale playback point", () => {
  const target = skipTarget(6, null, -10, 120);
  assert.equal(target, 0);
  assert.equal(clampSeekTarget(0, 120), 0);
  assert.equal(seekHasArrived(0, target, true), false);
  assert.equal(seekHasArrived(0, target), true);
});

test("seek targets stay within the media duration and reject invalid input", () => {
  assert.equal(skipTarget(115, null, 10, 120), 120);
  assert.equal(clampSeekTarget(-5, 120), 0);
  assert.equal(clampSeekTarget("bad", 120), null);
  assert.equal(clampSeekTarget(5, 0), null);
});

test("maps absolute seeks into single and multiple local HLS ranges", () => {
  assert.equal(localSeekPosition(612, 600, ranges([[0, 30]])), 12);
  assert.equal(localSeekPosition(645, 600, ranges([[0, 20], [40, 60]])), 45);
  assert.equal(localSeekPosition(630, 600, ranges([[0, 20], [40, 60]])), null);
});

test("rebuilds for unavailable, earlier, and invalid HLS targets", () => {
  const seekable = ranges([[0, 30]]);
  assert.equal(localSeekPosition(599, 600, seekable), null);
  assert.equal(localSeekPosition(640, 600, seekable), null);
  assert.equal(localSeekPosition("invalid", 600, seekable), null);
  assert.equal(localSeekPosition(610, Number.NaN, seekable), null);
});
