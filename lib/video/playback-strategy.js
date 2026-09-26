import { audioTrackByIndex, selectAudioTrack } from "./audio-tracks.js";
import { capabilityAllows, normalizeCapabilityStatus } from "./media-capabilities.js";

const HLS_COPY_AUDIO = new Set(["aac", "ac3", "eac3"]);

function capability(capabilities, group, key) {
  return normalizeCapabilityStatus(capabilities?.[group]?.[key]);
}

function requireBoth(first, second) {
  if (first === "unsupported" || second === "unsupported") return "unsupported";
  if (first === "supported" && second === "supported") return "supported";
  return "unknown";
}

function videoStatus(media, capabilities) {
  const video = media.video || {};
  const codec = capability(capabilities, "video", media.videoCodec);
  if (codec === "unsupported") return codec;
  if (video.dolbyVision) return requireBoth(codec, capability(capabilities, "video", "dolbyVision"));
  if (video.hdrFormat) return requireBoth(codec, capability(capabilities, "video", "hdr"));
  return codec;
}

function audioStatus(track, capabilities) {
  return track?.codec ? capability(capabilities, "audio", track.codec) : "supported";
}

function failed(options, name) {
  return Array.isArray(options.failedStrategies) && options.failedStrategies.includes(name);
}

function outputFor(media, audio, values = {}) {
  return {
    container: values.segmentFormat === "fmp4" ? "fmp4" : values.delivery === "direct" ? media.container : "mpegts",
    videoCodec: values.videoCodec || media.videoCodec,
    audioCodec: values.audioCodec === undefined ? audio?.codec || null : values.audioCodec,
    hdrFormat: values.hdrFormat === undefined ? media.video?.hdrFormat || null : values.hdrFormat,
  };
}

function plan(name, media, audio, values) {
  return {
    name,
    delivery: values.delivery || "hls",
    videoAction: values.videoAction || "copy",
    audioAction: values.audioAction || (audio ? "copy" : "none"),
    audioStreamIndex: audio?.index ?? null,
    audioChannels: audio?.channels ?? null,
    segmentFormat: values.segmentFormat || "mpegts",
    probe: Boolean(values.probe),
    output: outputFor(media, audio, values),
  };
}

function fmp4Required(media, audio) {
  return media.videoCodec === "hevc" || Boolean(media.video?.dolbyVision)
    || ["ac3", "eac3"].includes(audio?.codec);
}

function audioFallback(capabilities, channels, excludedCodecs = []) {
  const surround = Number(channels) > 2;
  const excluded = new Set(excludedCodecs);
  const candidates = (surround
    ? [["eac3", "eac3"], ["ac3", "ac3"], ["aac", "aac"]]
    : [["aac", "aac"]]).filter(([, codec]) => !excluded.has(codec));
  const supported = candidates.find(([key]) => capability(capabilities, "audio", key) === "supported");
  if (supported) return supported[1];
  const possible = candidates.find(([key]) => capabilityAllows(capability(capabilities, "audio", key)));
  return possible?.[1] || "aac";
}

function compatibleDolbyVisionBase(video) {
  return ["hdr10", "hlg", "sdr"].includes(video?.dolbyVision?.baseLayerCompatibility)
    ? video.dolbyVision.baseLayerCompatibility : null;
}

export function choosePlaybackStrategy(media, capabilities = {}, options = {}) {
  const audio = audioTrackByIndex(media.audioStreams, options.audioStreamIndex)
    || selectAudioTrack(media.audioStreams);
  const directStatus = normalizeCapabilityStatus(capabilities.direct);
  const sourceVideoStatus = videoStatus(media, capabilities);
  const sourceAudioStatus = audioStatus(audio, capabilities);
  const allowUnknown = options.allowUnknown !== false;
  const failedAudioCodecs = Array.isArray(options.failedAudioCodecs) ? options.failedAudioCodecs : [];
  // HDR and Dolby Vision support must be a positive, smooth-decoding signal.
  // Optimistic passthrough can overwhelm otherwise compatible TV decoders and
  // leaves the media element waiting forever without producing a fatal error.
  const sourceVideoAllowed = sourceVideoStatus === "supported"
    || (!media.video?.hdrFormat && capabilityAllows(sourceVideoStatus, allowUnknown));

  if (!failed(options, "direct") && capabilityAllows(directStatus, allowUnknown)
    && sourceVideoAllowed
    && capabilityAllows(sourceAudioStatus, allowUnknown)) {
    return plan("direct", media, audio, {
      delivery: "direct",
      probe: [directStatus, sourceVideoStatus, sourceAudioStatus].includes("unknown"),
    });
  }

  const hlsStatus = normalizeCapabilityStatus(capabilities.hls);
  const canUseHls = capabilityAllows(hlsStatus, allowUnknown);
  const copyAudioMuxable = !audio || HLS_COPY_AUDIO.has(audio.codec);
  if (!failed(options, "remux") && canUseHls && copyAudioMuxable
    && sourceVideoAllowed
    && capabilityAllows(sourceAudioStatus, allowUnknown)) {
    const segmentFormat = fmp4Required(media, audio) ? "fmp4" : "mpegts";
    return plan("remux", media, audio, {
      segmentFormat,
      probe: [hlsStatus, sourceVideoStatus, sourceAudioStatus].includes("unknown"),
    });
  }

  const baseLayer = compatibleDolbyVisionBase(media.video);
  const baseLayerSupported = baseLayer === "sdr"
    || (capability(capabilities, "video", "hevc") === "supported"
      && capability(capabilities, "video", "hdr") === "supported");
  if (!failed(options, "selective-transcode") && canUseHls && media.video?.dolbyVision
    && sourceVideoStatus === "unsupported" && baseLayer && baseLayerSupported) {
    const copySelectedAudio = copyAudioMuxable && capabilityAllows(sourceAudioStatus, allowUnknown)
      && !failedAudioCodecs.includes(audio?.codec);
    const nextAudio = copySelectedAudio
      ? audio?.codec : audioFallback(capabilities, audio?.channels, failedAudioCodecs);
    return plan("selective-transcode", media, audio, {
      segmentFormat: "fmp4",
      videoAction: "use-compatible-base-layer",
      audioAction: nextAudio === audio?.codec ? "copy" : `transcode-${nextAudio}`,
      audioCodec: nextAudio,
      hdrFormat: baseLayer === "sdr" ? null : baseLayer,
      probe: sourceAudioStatus === "unknown",
    });
  }

  if (!failed(options, "selective-transcode") && canUseHls
    && sourceVideoAllowed) {
    const nextAudio = audioFallback(capabilities, audio?.channels, failedAudioCodecs);
    return plan("selective-transcode", media, audio, {
      segmentFormat: fmp4Required(media, { codec: nextAudio }) ? "fmp4" : "mpegts",
      audioAction: audio && nextAudio === audio.codec ? "copy" : `transcode-${nextAudio}`,
      audioCodec: audio ? nextAudio : null,
      probe: sourceVideoStatus === "unknown",
    });
  }

  if (!failed(options, "selective-transcode") && canUseHls
    && capabilityAllows(sourceAudioStatus, allowUnknown) && copyAudioMuxable) {
    return plan("selective-transcode", media, audio, {
      videoAction: "transcode-h264",
      audioAction: "copy",
      videoCodec: "h264",
      hdrFormat: null,
      segmentFormat: fmp4Required({ videoCodec: "h264", video: {} }, audio) ? "fmp4" : "mpegts",
      probe: sourceAudioStatus === "unknown",
    });
  }

  return plan("compatibility-transcode", media, audio, {
    videoAction: "transcode-h264",
    audioAction: audio ? "transcode-aac-stereo" : "none",
    videoCodec: "h264",
    audioCodec: audio ? "aac" : null,
    hdrFormat: null,
    segmentFormat: "mpegts",
  });
}

export function playbackPlanKey(plan) {
  return [plan.name, plan.delivery, plan.videoAction, plan.audioAction,
    plan.audioStreamIndex ?? "none", plan.segmentFormat].join(":");
}
