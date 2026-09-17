import assert from "node:assert/strict";
import test from "node:test";
import {
  autoplayReducer,
  isPlaybackAtEnd,
  NEXT_EPISODE_PROMPT_SECONDS,
  shouldOfferNextEpisode,
} from "../lib/playback/autoplay.js";

test("next episode timing uses the authoritative player timeline", () => {
  const duration = 45 * 60;
  assert.equal(shouldOfferNextEpisode(8 * 60, duration), false);
  assert.equal(shouldOfferNextEpisode(duration - NEXT_EPISODE_PROMPT_SECONDS - 1, duration), false);
  assert.equal(shouldOfferNextEpisode(duration - NEXT_EPISODE_PROMPT_SECONDS, duration), true);
  assert.equal(isPlaybackAtEnd(duration - 6, duration), false);
  assert.equal(isPlaybackAtEnd(duration - 5, duration), true);
  assert.equal(shouldOfferNextEpisode(10, 0), false);
  assert.equal(isPlaybackAtEnd(Number.NaN, duration), false);
});

test("autoplay becomes ready without starting a countdown", () => {
  const ready = autoplayReducer({ phase: "resolving", endReached: false }, {
    type: "ready",
    payload: { nextEpisode: { season: 1, number: 2 }, fileId: "4" },
  });
  assert.equal(ready.phase, "ready");
  assert.equal(ready.endReached, false);
  assert.equal(autoplayReducer(ready, { type: "advancing" }).phase, "advancing");
});

test("autoplay remembers an end reached while the next episode is resolving", () => {
  const resolving = autoplayReducer({ phase: "idle", endReached: false }, {
    type: "resolving",
    endReached: true,
  });
  const ready = autoplayReducer(resolving, {
    type: "ready",
    payload: { nextEpisode: { season: 1, number: 2 }, fileId: "4" },
  });
  assert.equal(ready.phase, "ready");
  assert.equal(ready.endReached, true);
});

test("autoplay can be cancelled, reset, and stopped at the end of a series", () => {
  const cancelled = autoplayReducer({ phase: "ready", endReached: false }, { type: "cancel" });
  assert.deepEqual(
    cancelled,
    { phase: "cancelled", endReached: false },
  );
  assert.equal(autoplayReducer(cancelled, { type: "ready", payload: { fileId: "late" } }), cancelled);
  assert.deepEqual(
    autoplayReducer({ phase: "cancelled" }, { type: "reset" }),
    { phase: "idle", endReached: false },
  );
  assert.deepEqual(autoplayReducer({ phase: "resolving" }, { type: "end" }), { phase: "end" });
});

test("autoplay exposes graceful manual fallback state", () => {
  const nextEpisode = { season: 2, number: 1 };
  assert.deepEqual(
    autoplayReducer(
      { phase: "resolving", endReached: true },
      { type: "manual", payload: { nextEpisode, error: "No source" } },
    ),
    { phase: "manual", endReached: true, nextEpisode, error: "No source" },
  );
});
