import assert from "node:assert/strict";
import test from "node:test";
import {
  episodeCode,
  formatPlaybackTime,
  historyHref,
  historyPrimaryAction,
  historyProgress,
} from "../lib/history/presentation.js";

const movie = {
  mediaType: "movie",
  tmdbId: 10,
  position: 125,
  duration: 600,
  completed: false,
};

const episode = {
  mediaType: "tv",
  tmdbId: 20,
  seasonNumber: 2,
  episodeNumber: 4,
  position: 300,
  duration: 1_800,
  completed: false,
};

test("formats playback durations for compact history labels", () => {
  assert.equal(formatPlaybackTime(0), "0:00");
  assert.equal(formatPlaybackTime(125), "2:05");
  assert.equal(formatPlaybackTime(3_723), "1:02:03");
  assert.equal(formatPlaybackTime(-5), "0:00");
});

test("builds movie and exact-episode playback links", () => {
  assert.equal(historyHref(movie), "/movies/10?resume=1");
  assert.equal(historyHref(movie, "start"), "/movies/10?start=1");
  assert.equal(historyHref(episode), "/shows/20?resume=1&season=2&episode=4");
  assert.equal(historyHref(episode, "start"), "/shows/20?start=1&season=2&episode=4");
  assert.equal(episodeCode(episode), "S02E04");
});

test("uses one context-appropriate primary action", () => {
  assert.deepEqual(historyPrimaryAction(movie), {
    label: "Resume",
    href: "/movies/10?resume=1",
  });
  assert.deepEqual(historyPrimaryAction({ ...episode, completed: true }), {
    label: "Play again",
    href: "/shows/20?start=1&season=2&episode=4",
  });
});

test("clamps partial progress and presents completed content as full", () => {
  assert.equal(historyProgress(movie), 125 / 600);
  assert.equal(historyProgress({ ...movie, position: 900 }), 1);
  assert.equal(historyProgress({ ...movie, position: -10 }), 0);
  assert.equal(historyProgress({ ...movie, duration: 0 }), 0);
  assert.equal(historyProgress({ ...movie, position: 570, completed: true }), 1);
});
