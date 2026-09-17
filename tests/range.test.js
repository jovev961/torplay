import assert from "node:assert/strict";
import test from "node:test";
import { parseByteRange } from "../lib/video/range.js";

test("returns a full response when Range is absent", () => {
  assert.deepEqual(parseByteRange(null, 1000), { start: 0, end: 999, partial: false });
});

test("parses bounded and open-ended ranges", () => {
  assert.deepEqual(parseByteRange("bytes=10-19", 1000), { start: 10, end: 19, partial: true });
  assert.deepEqual(parseByteRange("bytes=900-", 1000), { start: 900, end: 999, partial: true });
  assert.deepEqual(parseByteRange("bytes=900-2000", 1000), {
    start: 900,
    end: 999,
    partial: true,
  });
});

test("parses suffix ranges", () => {
  assert.deepEqual(parseByteRange("bytes=-100", 1000), { start: 900, end: 999, partial: true });
  assert.deepEqual(parseByteRange("bytes=-2000", 1000), { start: 0, end: 999, partial: true });
});

test("rejects malformed, multiple, and unsatisfiable ranges", () => {
  for (const header of ["bytes=", "items=0-1", "bytes=0-1,3-4", "bytes=1000-", "bytes=9-2"] ) {
    assert.deepEqual(parseByteRange(header, 1000), { error: true });
  }
  assert.deepEqual(parseByteRange(null, 0), { error: true });
});
