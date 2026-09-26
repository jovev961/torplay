import assert from "node:assert/strict";
import test from "node:test";
import {
  episodeFileCardModel,
  episodeFilePresentation,
  formatEpisodeCode,
  formatFileSize,
  parseEpisodeIdentity,
  parseEpisodeTitle,
} from "../lib/video/episode-display.js";

test("recognizes common episode filename and directory conventions", () => {
  assert.deepEqual(parseEpisodeIdentity("Show.S01E02.1080p.mkv"), { season: 1, episode: 2 });
  assert.deepEqual(parseEpisodeIdentity("Show.2x07.720p.mp4"), { season: 2, episode: 7 });
  assert.deepEqual(
    parseEpisodeIdentity("Show/Season 03/Episode 11/video.mkv"),
    { season: 3, episode: 11 },
  );
  assert.equal(parseEpisodeIdentity("Show/bonus-feature.mkv"), null);
  assert.equal(formatEpisodeCode(1, 2), "S01E02");
});

test("unidentified cards lead with the real filename and reveal long paths only", () => {
  const short = episodeFilePresentation({ name: "OP-1.mkv", size: 40_000_000 });
  assert.deepEqual(episodeFileCardModel(short), { primary: "OP-1.mkv", expandable: false });
  const long = episodeFilePresentation({ name: "OP-29 L@mBerT.mkv",
    relativePath: "One Piece Season 1 2 3 [Eng Subbed]/Season_1 First_Voyage/OP-29 L@mBerT.mkv",
    size: 40_000_000 });
  assert.equal(episodeFileCardModel(long).primary, "OP-29 L@mBerT.mkv");
  assert.equal(episodeFileCardModel(long).expandable, true);
  assert.match(long.fullPath, /Season_1 First_Voyage/);
  const identified = episodeFilePresentation({ name: "Show.S01E01.mp4", size: 40_000_000 });
  assert.deepEqual(episodeFileCardModel(identified), { primary: "S01E01 · Episode 1", expandable: false });
});

test("cleans episode titles without repeating release metadata", () => {
  assert.equal(
    parseEpisodeTitle("Reacher.S01E02.First.Dance.1080p.10bit.AMZN.WEB-DL.DDP5.1.HEVC-Vyndros.mkv"),
    "First Dance",
  );
  assert.equal(parseEpisodeTitle("Show.1x03.The_Return.720p.x264.mkv"), "The Return");
  assert.equal(parseEpisodeTitle("video.mkv"), null);
});

test("uses TMDB titles first and infers compact technical labels", () => {
  const display = episodeFilePresentation({
    name: "Reacher.S01E02.First.Dance.1080p.10bit.HEVC.mkv",
    relativePath: "Reacher (2022)/Season 1/Reacher.S01E02.First.Dance.1080p.10bit.HEVC.mkv",
    size: 1_181_116_006,
  }, [{ season: 1, number: 2, title: "First Dance (Official)" }]);

  assert.deepEqual(display, {
    code: "S01E02",
    title: "First Dance (Official)",
    technical: ["1080p", "HEVC", "1.1 GB"],
    mediaBadges: [{ id: "hevc", label: "HEVC / H.265", verification: "inferred" }],
    filename: "Reacher.S01E02.First.Dance.1080p.10bit.HEVC.mkv",
    fullPath: "Reacher (2022)/Season 1/Reacher.S01E02.First.Dance.1080p.10bit.HEVC.mkv",
    recognized: true,
  });
});

test("falls back to parsed titles, container labels, and safe unknown choices", () => {
  const parsed = episodeFilePresentation({
    name: "Show.S02E04.The.Guest.720p.mkv",
    size: 734_003_200,
  });
  assert.equal(parsed.title, "The Guest");
  assert.deepEqual(parsed.technical, ["720p", "MKV", "700 MB"]);

  const unknown = episodeFilePresentation({ name: "bonus-feature.mp4", size: 0 });
  assert.equal(unknown.code, null);
  assert.equal(unknown.title, "Unidentified episode");
  assert.deepEqual(unknown.technical, ["MP4", "0 B"]);
  assert.equal(formatFileSize(Number.NaN), "Unknown size");
});
