import assert from "node:assert/strict";
import test from "node:test";
import {
  inferMediaBadges,
  playbackMediaBadges,
  verifiedMediaBadges,
} from "../lib/video/media-capabilities.js";

test("infers Dolby, HDR, audio, and HEVC badges without release-name false positives", () => {
  assert.deepEqual(
    inferMediaBadges("Film.2160p.DoVi.HDR10+.HEVC.TrueHD.Atmos.DDP5.1.mkv").map((badge) => badge.id),
    ["dolby-vision", "hdr10-plus", "hevc", "atmos", "truehd", "eac3"],
  );
  assert.deepEqual(
    inferMediaBadges("Film.1080p.Dolby.Digital.AC3.H265.mkv").map((badge) => badge.id),
    ["hevc", "ac3"],
  );
  assert.equal(inferMediaBadges("Film.DVDRip.XviD.avi").some((badge) => badge.id === "dolby-vision"), false);
});

test("verified badges replace inferred claims and follow the selected audio track", () => {
  const media = {
    videoCodec: "hevc",
    video: { dolbyVision: null, hdrFormat: "hdr10" },
    audioStreams: [
      { index: 2, codec: "eac3", atmos: true, default: true },
      { index: 5, codec: "truehd", atmos: null },
    ],
  };
  assert.deepEqual(verifiedMediaBadges(media, 2).map((badge) => badge.id),
    ["hdr10", "hevc", "atmos", "eac3"]);
  assert.deepEqual(verifiedMediaBadges(media, 5).map((badge) => badge.id),
    ["hdr10", "hevc", "truehd"]);
});

test("playback badges distinguish active formats from unused source formats", () => {
  const media = {
    badges: [
      { id: "dolby-vision", label: "Dolby Vision", verification: "verified" },
      { id: "hevc", label: "HEVC / H.265", verification: "verified" },
      { id: "atmos", label: "Atmos", verification: "verified" },
      { id: "truehd", label: "TrueHD", verification: "verified" },
    ],
  };
  const badges = playbackMediaBadges(media, {
    videoAction: "use-compatible-base-layer",
    audioAction: "transcode-eac3",
    output: { videoCodec: "hevc", audioCodec: "eac3", hdrFormat: "hdr10" },
  });
  assert.deepEqual(
    badges.map((entry) => [entry.id, entry.playbackStatus]),
    [
      ["dolby-vision", "inactive"],
      ["hevc", "active"],
      ["atmos", "inactive"],
      ["truehd", "inactive"],
      ["hdr10", "active"],
      ["eac3", "active"],
    ],
  );
});

test("copied Atmos audio and Dolby Vision are marked active", () => {
  const badges = playbackMediaBadges({ badges: [
    { id: "dolby-vision", label: "Dolby Vision", verification: "verified" },
    { id: "atmos", label: "Atmos", verification: "verified" },
    { id: "eac3", label: "EAC3 / DD+", verification: "verified" },
  ] }, {
    videoAction: "copy", audioAction: "copy",
    output: { videoCodec: "hevc", audioCodec: "eac3", hdrFormat: "dolby-vision" },
  });
  assert.equal(badges.every((entry) => entry.playbackStatus === "active"), true);
});
