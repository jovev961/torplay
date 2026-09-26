import assert from "node:assert/strict";
import test from "node:test";
import { choosePlaybackStrategy } from "../lib/video/playback-strategy.js";

const dvMedia = {
  container: "matroska,webm",
  videoCodec: "hevc",
  video: { hdrFormat: "dolby-vision", dolbyVision: { baseLayerCompatibility: "hdr10" } },
  audioCodec: "eac3",
  audioStreams: [{ index: 2, codec: "eac3", channels: 6, default: true }],
};

const capable = {
  direct: "supported", hls: "supported",
  video: { h264: "supported", hevc: "supported", hdr: "supported", dolbyVision: "supported" },
  audio: { aac: "supported", ac3: "supported", eac3: "supported", truehd: "unsupported" },
};

test("prefers direct play, then fMP4 remux for supported Dolby media", () => {
  assert.equal(choosePlaybackStrategy(dvMedia, capable).name, "direct");
  const remux = choosePlaybackStrategy(dvMedia, { ...capable, direct: "unsupported" });
  assert.equal(remux.name, "remux");
  assert.equal(remux.segmentFormat, "fmp4");
  assert.equal(remux.videoAction, "copy");
  assert.equal(remux.audioAction, "copy");
});

test("copies Dolby Vision video and converts only unsupported TrueHD audio", () => {
  const media = { ...dvMedia, audioCodec: "truehd",
    audioStreams: [{ index: 4, codec: "truehd", channels: 8, default: true }] };
  const selected = choosePlaybackStrategy(media, { ...capable, direct: "unsupported" });
  assert.equal(selected.name, "selective-transcode");
  assert.equal(selected.videoAction, "copy");
  assert.equal(selected.audioAction, "transcode-eac3");
  assert.equal(selected.output.audioCodec, "eac3");
});

test("keeps HDR video while stepping down failed surround audio codecs", () => {
  const media = { ...dvMedia, audioCodec: "truehd",
    audioStreams: [{ index: 4, codec: "truehd", channels: 8, default: true }] };
  const ac3 = choosePlaybackStrategy(media, { ...capable, direct: "unsupported" }, {
    failedAudioCodecs: ["eac3"],
  });
  assert.equal(ac3.name, "selective-transcode");
  assert.equal(ac3.videoAction, "copy");
  assert.equal(ac3.audioAction, "transcode-ac3");
  assert.equal(ac3.output.hdrFormat, "dolby-vision");

  const aac = choosePlaybackStrategy(media, { ...capable, direct: "unsupported" }, {
    failedAudioCodecs: ["eac3", "ac3"],
  });
  assert.equal(aac.name, "selective-transcode");
  assert.equal(aac.videoAction, "copy");
  assert.equal(aac.audioAction, "transcode-aac");
  assert.equal(aac.output.videoCodec, "hevc");
  assert.equal(aac.output.hdrFormat, "dolby-vision");
});

test("uses a compatible HDR base layer when Dolby Vision itself is unsupported", () => {
  const selected = choosePlaybackStrategy(dvMedia, {
    ...capable,
    direct: "unsupported",
    video: { ...capable.video, dolbyVision: "unsupported" },
  });
  assert.equal(selected.name, "selective-transcode");
  assert.equal(selected.videoAction, "use-compatible-base-layer");
  assert.equal(selected.output.hdrFormat, "hdr10");
});

test("does not optimistically pass HDR video through without smooth-decoding evidence", () => {
  const selected = choosePlaybackStrategy(dvMedia, {
    direct: "unknown", hls: "supported",
    video: { h264: "supported", hevc: "unknown", hdr: "unknown", dolbyVision: "unknown" },
    audio: { aac: "supported", eac3: "supported" },
  }, { allowUnknown: true });

  assert.equal(selected.name, "selective-transcode");
  assert.equal(selected.videoAction, "transcode-h264");
  assert.equal(selected.output.hdrFormat, null);
});

test("keeps H.264 and AAC stereo as the final compatibility fallback", () => {
  const unsupported = {
    direct: "unsupported", hls: "supported",
    video: { h264: "supported", hevc: "unsupported", hdr: "unsupported", dolbyVision: "unsupported" },
    audio: { aac: "supported", ac3: "unsupported", eac3: "unsupported", truehd: "unsupported" },
  };
  const selected = choosePlaybackStrategy({ ...dvMedia,
    video: { hdrFormat: "dolby-vision", dolbyVision: { baseLayerCompatibility: null } } }, unsupported);
  assert.equal(selected.name, "compatibility-transcode");
  assert.equal(selected.videoAction, "transcode-h264");
  assert.equal(selected.audioAction, "transcode-aac-stereo");
});

test("advances past failed optimistic strategies without retry loops", () => {
  assert.equal(choosePlaybackStrategy(dvMedia, capable, { failedStrategies: ["direct"] }).name, "remux");
  assert.equal(choosePlaybackStrategy(dvMedia, capable,
    { failedStrategies: ["direct", "remux", "selective-transcode"] }).name,
  "compatibility-transcode");
});
