import assert from "node:assert/strict";
import test from "node:test";
import { detectClientCapabilities, videoCodecString } from "../lib/video/client-capabilities.js";

const media = {
  sourceMimeType: "video/mp4",
  videoCodec: "hevc",
  video: { codecTag: "dvh1", width: 3840, height: 2160, frameRate: 24,
    bitRate: 20_000_000, colorPrimaries: "bt2020", colorTransfer: "smpte2084",
    hdrFormat: "dolby-vision", dolbyVision: { profile: 5, level: 6 } },
  audioTracks: [{ index: 2, codec: "eac3", channels: 6, sampleRate: 48000,
    bitRate: 640000, atmos: true, default: true }],
};

const hdr10Media = {
  ...media,
  video: { ...media.video, codecTag: "hvc1", profile: "Main 10", level: 153,
    hdrFormat: "hdr10", dolbyVision: null },
};

test("builds an exact Dolby Vision codec identifier", () => {
  assert.equal(videoCodecString(media), "dvh1.05.06");
});

test("builds the RFC 6381 Main 10 HEVC identifier required by Chrome", () => {
  assert.equal(videoCodecString(hdr10Media), "hvc1.2.4.L153.B0");
});

test("reports supported Dolby/HDR only from positive client signals", async () => {
  const capabilities = await detectClientCapabilities(media, 2, {
    videoElement: { canPlayType: () => "probably" },
    navigatorRef: { mediaCapabilities: { decodingInfo: async () => ({ supported: true }) } },
    mediaSourceRef: { isTypeSupported: () => true },
    matchMediaRef: () => ({ matches: true }),
  });
  assert.equal(capabilities.direct, "supported");
  assert.equal(capabilities.video.dolbyVision, "supported");
  assert.equal(capabilities.video.hdr, "supported");
  assert.equal(capabilities.audio.eac3, "supported");
  assert.equal(capabilities.audio.atmos, "supported");
});

test("rejects nominal codec support when the TV reports decoding is not smooth", async () => {
  const capabilities = await detectClientCapabilities(media, 2, {
    videoElement: { canPlayType: (type) => type === "application/vnd.apple.mpegurl" ? "" : "probably" },
    navigatorRef: { mediaCapabilities: { decodingInfo: async () => ({ supported: true, smooth: false }) } },
    mediaSourceRef: { isTypeSupported: () => true },
    matchMediaRef: () => ({ matches: true }),
  });
  assert.equal(capabilities.direct, "unsupported");
  assert.equal(capabilities.video.hevc, "unsupported");
  assert.equal(capabilities.video.dolbyVision, "unsupported");
});

test("uses a TV's native HLS hardware path for HDR when MSE is not smooth", async () => {
  const capabilities = await detectClientCapabilities(media, 2, {
    videoElement: { canPlayType: (type) => type === "application/vnd.apple.mpegurl" ? "maybe" : "probably" },
    navigatorRef: {
      vendor: "Samsung",
      userAgent: "Mozilla/5.0 (SMART-TV; Linux; Tizen 8.0)",
      mediaCapabilities: { decodingInfo: async () => ({ supported: true, smooth: false }) },
    },
    mediaSourceRef: { isTypeSupported: () => true },
    matchMediaRef: () => ({ matches: true }),
  });

  assert.equal(capabilities.direct, "unsupported");
  assert.equal(capabilities.transport.nativeHls, "supported");
  assert.equal(capabilities.video.hevc, "supported");
  assert.equal(capabilities.video.dolbyVision, "supported");
});

test("keeps ambiguous canPlayType answers unknown instead of assuming support", async () => {
  const capabilities = await detectClientCapabilities(media, 2, {
    videoElement: { canPlayType: () => "maybe" },
    navigatorRef: {}, mediaSourceRef: null,
    matchMediaRef: () => ({ matches: true }),
  });
  assert.equal(capabilities.direct, "unknown");
  assert.equal(capabilities.video.dolbyVision, "unknown");
  assert.equal(capabilities.audio.eac3, "unknown");
  assert.equal(capabilities.transport.nativeHls, "unknown");
});

test("uses native HLS whenever the browser exposes the native playlist handler", async () => {
  const capabilities = await detectClientCapabilities(media, 2, {
    videoElement: { canPlayType: (type) => type === "application/vnd.apple.mpegurl" ? "maybe" : "" },
    navigatorRef: { vendor: "Apple Computer, Inc.", userAgent: "Version/26.0 Safari/620.1" },
    mediaSourceRef: null,
    matchMediaRef: () => ({ matches: true }),
  });
  assert.equal(capabilities.transport.nativeHls, "supported");
  assert.equal(capabilities.hls, "supported");
});

test("does not mistake Chrome's ambiguous HLS answer for native HLS", async () => {
  const capabilities = await detectClientCapabilities(hdr10Media, 2, {
    videoElement: { canPlayType: (type) => type.includes("hvc1.2.4.L153.B0") ? "probably"
      : type === "application/vnd.apple.mpegurl" ? "maybe" : "" },
    navigatorRef: { vendor: "Google Inc.", userAgent: "Chrome/153.0.0.0" },
    mediaSourceRef: { isTypeSupported: (type) => type.includes("hvc1.2.4.L153.B0") },
    matchMediaRef: () => ({ matches: true }),
  });
  assert.equal(capabilities.transport.nativeHls, "unknown");
  assert.equal(capabilities.video.hevc, "supported");
  assert.equal(capabilities.video.hdr, "supported");
});
