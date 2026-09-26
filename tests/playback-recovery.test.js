import assert from "node:assert/strict";
import test from "node:test";
import { nextPlaybackFallback } from "../lib/video/playback-recovery.js";

test("steps down surround audio without abandoning preserved HDR video", () => {
  const current = { failedStrategies: ["direct", "remux"], failedAudioCodecs: [] };
  const eac3 = nextPlaybackFallback({
    strategy: "selective-transcode",
    playbackPlan: { videoAction: "copy", output: { videoCodec: "hevc", hdrFormat: "hdr10", audioCodec: "eac3" } },
  }, current);
  assert.deepEqual(eac3, {
    retry: true,
    failedStrategies: ["direct", "remux"],
    failedAudioCodecs: ["eac3"],
  });

  const ac3 = nextPlaybackFallback({
    strategy: "selective-transcode",
    playbackPlan: { videoAction: "copy", output: { videoCodec: "hevc", hdrFormat: "hdr10", audioCodec: "ac3" } },
  }, eac3);
  assert.deepEqual(ac3.failedAudioCodecs, ["eac3", "ac3"]);
  assert.deepEqual(ac3.failedStrategies, ["direct", "remux"]);
});

test("abandons selective conversion only after its preserved-video AAC output fails", () => {
  const fallback = nextPlaybackFallback({
    strategy: "selective-transcode",
    playbackPlan: { videoAction: "copy", output: { videoCodec: "hevc", hdrFormat: "hdr10", audioCodec: "aac" } },
  }, { failedStrategies: ["direct", "remux"], failedAudioCodecs: ["eac3", "ac3"] });
  assert.equal(fallback.retry, true);
  assert.deepEqual(fallback.failedStrategies, ["direct", "remux", "selective-transcode"]);
  assert.deepEqual(fallback.failedAudioCodecs, ["eac3", "ac3"]);

  assert.equal(nextPlaybackFallback({ strategy: "compatibility-transcode" }, fallback).retry, false);
});
