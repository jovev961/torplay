import assert from "node:assert/strict";
import test from "node:test";
import { waitForSynchronizedPosition } from "../lib/video/media-readiness.js";

class FakeMediaElement extends EventTarget {
  constructor({ currentTime = 0, readyState = 0, seeking = false } = {}) {
    super();
    this.currentTime = currentTime;
    this.readyState = readyState;
    this.seeking = seeking;
  }
}

test("accepts Safari's paused current frame at the shared position", async () => {
  const video = new FakeMediaElement({ currentTime: 5032.9, readyState: 2 });
  await waitForSynchronizedPosition(video, 5032.9, { timeoutMs: 25 });
});

test("waits until the shared position has arrived and decoded current data", async () => {
  const video = new FakeMediaElement({ currentTime: 10, readyState: 1, seeking: true });
  const ready = waitForSynchronizedPosition(video, 90, { timeoutMs: 100 });

  video.currentTime = 90;
  video.seeking = false;
  video.dispatchEvent(new Event("seeked"));
  video.readyState = 2;
  video.dispatchEvent(new Event("loadeddata"));

  await ready;
});

test("rejects media errors and positions that never become ready", async () => {
  const failed = new FakeMediaElement({ currentTime: 30, readyState: 1, seeking: true });
  const failure = waitForSynchronizedPosition(failed, 60, { timeoutMs: 100 });
  failed.dispatchEvent(new Event("error"));
  await assert.rejects(failure, /could not seek/);

  const stalled = new FakeMediaElement({ currentTime: 60, readyState: 1 });
  await assert.rejects(
    waitForSynchronizedPosition(stalled, 60, { timeoutMs: 10 }),
    /did not reach the shared position in time/,
  );
});
