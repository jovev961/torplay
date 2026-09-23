import assert from "node:assert/strict";
import test from "node:test";
import {
  isFullscreenActive,
  lockFullscreenViewport,
  supportsFullscreen,
  toggleBrowserFullscreen,
} from "../lib/video/fullscreen.js";

test("uses the standard element fullscreen API when available", async () => {
  const calls = [];
  const player = { requestFullscreen: () => calls.push("enter") };
  const documentRef = { fullscreenElement: null };

  assert.equal(supportsFullscreen(player), true);
  assert.equal(await toggleBrowserFullscreen(documentRef, player), "enter");
  assert.deepEqual(calls, ["enter"]);

  documentRef.fullscreenElement = player;
  documentRef.exitFullscreen = () => calls.push("exit");
  assert.equal(isFullscreenActive(documentRef, player, null), true);
  assert.equal(await toggleBrowserFullscreen(documentRef, player), "exit");
  assert.deepEqual(calls, ["enter", "exit"]);
});

test("supports prefixed WebKit element fullscreen", async () => {
  const calls = [];
  const player = { webkitRequestFullscreen: () => calls.push("enter") };
  const documentRef = {
    webkitFullscreenElement: null,
    webkitExitFullscreen: () => calls.push("exit"),
  };

  assert.equal(await toggleBrowserFullscreen(documentRef, player), "enter");
  documentRef.webkitFullscreenElement = player;
  assert.equal(await toggleBrowserFullscreen(documentRef, player), "exit");
  assert.deepEqual(calls, ["enter", "exit"]);
});

test("uses viewport fullscreen instead of native iPhone video fullscreen", async () => {
  const calls = [];
  const video = {
    webkitSupportsFullscreen: true,
    webkitEnterFullscreen: () => calls.push("native"),
  };

  assert.equal(supportsFullscreen(null, { viewportFallback: true }), true);
  assert.equal(await toggleBrowserFullscreen({}, null, {
    enterViewport: () => calls.push("viewport"),
  }), "enter");
  assert.deepEqual(calls, ["viewport"]);
  assert.equal(video.webkitDisplayingFullscreen, undefined);
});

test("falls back to viewport fullscreen when element fullscreen is rejected", async () => {
  const calls = [];
  const player = {
    requestFullscreen: () => {
      calls.push("browser");
      throw new Error("Element fullscreen unavailable");
    },
  };

  assert.equal(await toggleBrowserFullscreen({}, player, {
    enterViewport: () => calls.push("viewport"),
  }), "enter");
  assert.deepEqual(calls, ["browser", "viewport"]);
});

test("tracks externally entered video fullscreen without selecting it as TorPlay's mode", () => {
  const video = { requestFullscreen() {} };
  const documentRef = { fullscreenElement: video };

  assert.equal(supportsFullscreen(null), false);
  assert.equal(isFullscreenActive(documentRef, null, video), true);
});

test("exits viewport fullscreen without invoking browser or video APIs", async () => {
  const calls = [];
  assert.equal(await toggleBrowserFullscreen({}, null, {
    viewportActive: true,
    exitViewport: () => calls.push("exit-viewport"),
  }), "exit");
  assert.deepEqual(calls, ["exit-viewport"]);
});

test("viewport fullscreen locks page scrolling and restores existing styles", () => {
  const documentRef = {
    documentElement: { style: { overflow: "auto", overscrollBehavior: "contain" } },
    body: { style: { overflow: "scroll", overscrollBehavior: "auto" } },
  };

  const unlock = lockFullscreenViewport(documentRef);
  assert.deepEqual(documentRef.documentElement.style, {
    overflow: "hidden",
    overscrollBehavior: "none",
  });
  assert.deepEqual(documentRef.body.style, {
    overflow: "hidden",
    overscrollBehavior: "none",
  });

  unlock();
  assert.deepEqual(documentRef.documentElement.style, {
    overflow: "auto",
    overscrollBehavior: "contain",
  });
  assert.deepEqual(documentRef.body.style, {
    overflow: "scroll",
    overscrollBehavior: "auto",
  });
});

test("does not advertise or invoke unavailable fullscreen APIs", async () => {
  assert.equal(supportsFullscreen(null), false);
  await assert.rejects(
    toggleBrowserFullscreen({}, null),
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
    toggleBrowserFullscreen({}, player),
    /Fullscreen permission denied/,
  );
});
