import assert from "node:assert/strict";
import test from "node:test";
import {
  isFullscreenActive,
  supportsFullscreen,
  toggleBrowserFullscreen,
} from "../lib/video/fullscreen.js";

test("uses the standard element fullscreen API when available", async () => {
  const calls = [];
  const player = { requestFullscreen: () => calls.push("enter") };
  const documentRef = { fullscreenElement: null };

  assert.equal(supportsFullscreen(player, null), true);
  assert.equal(await toggleBrowserFullscreen(documentRef, player, null), "enter");
  assert.deepEqual(calls, ["enter"]);

  documentRef.fullscreenElement = player;
  documentRef.exitFullscreen = () => calls.push("exit");
  assert.equal(isFullscreenActive(documentRef, player, null), true);
  assert.equal(await toggleBrowserFullscreen(documentRef, player, null), "exit");
  assert.deepEqual(calls, ["enter", "exit"]);
});

test("supports prefixed WebKit element fullscreen", async () => {
  const calls = [];
  const player = { webkitRequestFullscreen: () => calls.push("enter") };
  const documentRef = {
    webkitFullscreenElement: null,
    webkitExitFullscreen: () => calls.push("exit"),
  };

  assert.equal(await toggleBrowserFullscreen(documentRef, player, null), "enter");
  documentRef.webkitFullscreenElement = player;
  assert.equal(await toggleBrowserFullscreen(documentRef, player, null), "exit");
  assert.deepEqual(calls, ["enter", "exit"]);
});

test("prefers custom player fullscreen when native video fullscreen is also available", async () => {
  const calls = [];
  const player = { requestFullscreen: () => calls.push("custom") };
  const video = {
    requestFullscreen: () => calls.push("video"),
    webkitSupportsFullscreen: true,
    webkitEnterFullscreen: () => calls.push("native"),
  };

  assert.equal(supportsFullscreen(player, video), true);
  assert.equal(await toggleBrowserFullscreen({}, player, video), "enter");
  assert.deepEqual(calls, ["custom"]);
});

test("prefers WebKit player fullscreen over video element fallbacks", async () => {
  const calls = [];
  const player = { webkitRequestFullscreen: () => calls.push("custom-webkit") };
  const video = {
    requestFullscreen: () => calls.push("video"),
    webkitSupportsFullscreen: true,
    webkitEnterFullscreen: () => calls.push("native"),
  };

  assert.equal(await toggleBrowserFullscreen({}, player, video), "enter");
  assert.deepEqual(calls, ["custom-webkit"]);
});

test("tracks standard fullscreen when only the video element supports it", async () => {
  const video = { requestFullscreen() {} };
  const documentRef = { fullscreenElement: video };

  assert.equal(supportsFullscreen(null, video), true);
  assert.equal(isFullscreenActive(documentRef, null, video), true);
});

test("falls back to native iPhone video fullscreen", async () => {
  const calls = [];
  const video = {
    webkitDisplayingFullscreen: false,
    webkitSupportsFullscreen: true,
    webkitEnterFullscreen() {
      calls.push("enter");
      this.webkitDisplayingFullscreen = true;
    },
    webkitExitFullscreen() {
      calls.push("exit");
      this.webkitDisplayingFullscreen = false;
    },
  };

  assert.equal(supportsFullscreen(null, video), true);
  assert.equal(await toggleBrowserFullscreen({}, null, video), "enter");
  assert.equal(isFullscreenActive({}, null, video), true);
  assert.equal(await toggleBrowserFullscreen({}, null, video), "exit");
  assert.deepEqual(calls, ["enter", "exit"]);
});

test("does not advertise or invoke unavailable fullscreen APIs", async () => {
  const unavailableVideo = {
    webkitSupportsFullscreen: false,
    webkitEnterFullscreen() {},
  };

  assert.equal(supportsFullscreen(null, unavailableVideo), false);
  await assert.rejects(
    toggleBrowserFullscreen({}, null, unavailableVideo),
    /does not support fullscreen playback/,
  );
});

test("preserves browser fullscreen errors", async () => {
  const player = {
    requestFullscreen() {
      throw new Error("Fullscreen permission denied");
    },
  };

  await assert.rejects(
    toggleBrowserFullscreen({}, player, null),
    /Fullscreen permission denied/,
  );
});
