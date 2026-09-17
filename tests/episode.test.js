import assert from "node:assert/strict";
import test from "node:test";
import {
  findEpisodeFile,
  findLargestFile,
  matchesEpisode,
  safeTorrentRelativePath,
} from "../lib/video/episode.js";

const files = [
  { id: "0", name: "Show.S01E01.1080p.mp4" },
  { id: "1", name: "Show.s01e02.1080p.webm" },
  { id: "2", name: "Show.S01E10.1080p.mp4" },
];

test("matches an exact SxxExx episode filename case-insensitively", () => {
  assert.equal(findEpisodeFile(files, 1, 2)?.id, "1");
  assert.equal(findEpisodeFile(files, 1, 1)?.id, "0");
});

test("does not confuse episode prefixes", () => {
  assert.equal(findEpisodeFile(files, 1, 3), null);
  assert.equal(matchesEpisode("Show.S01E010.mkv", 1, 1), false);
  assert.equal(matchesEpisode("Show.11x01.mkv", 1, 1), false);
});

test("matches common episode notations and nested torrent paths", () => {
  for (const value of [
    "Show.S01E01.mkv",
    "Show.s01e01.mkv",
    "Show.1x01.mkv",
    "Show.Season 1 Episode 1.mkv",
    "Show.Season 01 Episode 01.mkv",
    "Show/Season 01/Episode 01/video.mkv",
  ]) {
    assert.equal(matchesEpisode(value, 1, 1), true, value);
  }
  assert.equal(
    findEpisodeFile([
      { id: "4", name: "video.mkv", relativePath: "Show/Season 01/Episode 01/video.mkv" },
      { id: "8", name: "video.mkv", relativePath: "Show/Season 01/Episode 02/video.mkv" },
    ], 1, 2)?.id,
    "8",
  );
});

test("only exposes safe torrent-relative paths", () => {
  assert.equal(safeTorrentRelativePath("Show\\Season 01\\Episode 01.mkv"), "Show/Season 01/Episode 01.mkv");
  assert.equal(safeTorrentRelativePath("../private/video.mkv", "video.mkv"), "video.mkv");
  assert.equal(safeTorrentRelativePath("/tmp/private/video.mkv", "video.mkv"), "video.mkv");
  assert.equal(safeTorrentRelativePath("C:\\private\\video.mkv", "video.mkv"), "video.mkv");
});

test("falls back only when an individual torrent has one playable file", () => {
  assert.equal(findEpisodeFile([{ id: "7", name: "video.mp4" }], 2, 4)?.id, "7");
  assert.equal(findEpisodeFile([{ id: "7", name: "video.mp4" }, { id: "8", name: "extra.mp4" }], 2, 4), null);
});

test("exact matching never treats a single unrelated file as the next episode", () => {
  assert.equal(findEpisodeFile(
    [{ id: "7", name: "Show.S01E04.mp4" }],
    1,
    5,
    { allowSingleFileFallback: false },
  ), null);
  assert.equal(findEpisodeFile([
    { id: "7", name: "Show.S01E10.mp4" },
    { id: "8", name: "Show.S02E01.mp4" },
  ], 2, 1, { allowSingleFileFallback: false })?.id, "8");
});

test("selects the largest playable movie file", () => {
  assert.equal(findLargestFile([
    { id: "0", size: 100 },
    { id: "1", size: 500 },
    { id: "2", size: 200 },
  ])?.id, "1");
  assert.equal(findLargestFile([]), null);
});
