function statusFromCanPlay(value) {
  return value === "probably" ? "supported" : value === "" ? "unsupported" : "unknown";
}

function strongest(...values) {
  if (values.includes("supported")) return "supported";
  if (values.every((value) => value === "unsupported")) return "unsupported";
  return "unknown";
}

function performanceAwareStatus(container, ...decodingResults) {
  const measured = decodingResults.filter((value) => value !== "unknown");
  if (measured.includes("supported")) return "supported";
  if (measured.includes("unsupported")) return "unsupported";
  return container;
}

function both(first, second) {
  if (first === "unsupported" || second === "unsupported") return "unsupported";
  if (first === "supported" && second === "supported") return "supported";
  return "unknown";
}

function playableContainer(container, decoding) {
  if (container === "unsupported" || decoding === "unsupported") return "unsupported";
  if (container === "supported") return "supported";
  return "unknown";
}

function padCodecPart(value) {
  return Number.isFinite(Number(value)) ? String(Number(value)).padStart(2, "0") : "01";
}

function hevcCodecString(video) {
  const tag = /^(?:hvc1|hev1)$/i.test(video.codecTag || "")
    ? video.codecTag.toLowerCase() : "hvc1";
  const profile = /main\s*10/i.test(video.profile || "") ? 2
    : /still\s*picture/i.test(video.profile || "") ? 3 : 1;
  const compatibility = profile === 2 ? 4 : profile === 3 ? 0 : 6;
  const level = Number.isFinite(Number(video.level)) ? Number(video.level) : 120;
  const tier = /high/i.test(video.tier || "") ? "H" : "L";
  return `${tag}.${profile}.${compatibility}.${tier}${level}.B0`;
}

function nativeHlsStatus(answer, navigatorRef) {
  if (!answer) return "unsupported";
  if (answer === "probably") return "supported";
  const vendor = String(navigatorRef?.vendor || "");
  const userAgent = String(navigatorRef?.userAgent || "");
  const nativeTvBrowser = /(?:Tizen|Web0S|WebOS|NetCast|SMART[ ./_-]?TV|HbbTV|Viera|BRAVIA|AFT\w*|Roku|Hisense|VIDAA)/i
    .test(userAgent);
  return nativeTvBrowser || (/Apple/i.test(vendor)
    && !/(?:CriOS|Chrome|Chromium|EdgiOS|FxiOS)/i.test(userAgent))
    ? "supported" : "unknown";
}

export function videoCodecString(media) {
  const video = media?.video || {};
  if (video.dolbyVision) {
    return `${String(video.codecTag || "dvh1").toLowerCase().startsWith("dv")
      ? String(video.codecTag).toLowerCase() : "dvh1"}.${padCodecPart(video.dolbyVision.profile)}.${padCodecPart(video.dolbyVision.level)}`;
  }
  if (media?.videoCodec === "hevc") return hevcCodecString(video);
  if (media?.videoCodec === "h264") return /^(?:avc1|avc3)/i.test(video.codecTag || "")
    ? video.codecTag : "avc1.640028";
  if (media?.videoCodec === "av1") return "av01.0.08M.08";
  if (media?.videoCodec === "vp9") return "vp09.00.10.08";
  return media?.videoCodec || "";
}

export function audioCodecString(track) {
  if (track?.codec === "eac3") return "ec-3";
  if (track?.codec === "ac3") return "ac-3";
  if (track?.codec === "truehd") return "mlpa";
  if (track?.codec === "aac") return "mp4a.40.2";
  return track?.codec || "";
}

async function decodingStatus(mediaCapabilities, configuration) {
  if (!mediaCapabilities?.decodingInfo) return "unknown";
  try {
    const result = await mediaCapabilities.decodingInfo(configuration);
    if (result?.supported === false || result?.smooth === false) return "unsupported";
    return result?.supported === true ? "supported" : "unknown";
  } catch {
    return "unknown";
  }
}

function videoConfiguration(media, contentType) {
  const video = media.video || {};
  const configuration = {
    contentType,
    width: video.width || 1920,
    height: video.height || 1080,
    bitrate: video.bitRate || 8_000_000,
    framerate: video.frameRate || 24,
  };
  if (video.hdrFormat) {
    configuration.colorGamut = video.colorPrimaries === "bt2020" ? "rec2020" : "p3";
    configuration.transferFunction = video.colorTransfer === "arib-std-b67" ? "hlg" : "pq";
    if (video.hdrFormat === "hdr10") configuration.hdrMetadataType = "smpteSt2086";
    if (video.hdrFormat === "hdr10-plus") configuration.hdrMetadataType = "smpteSt2094-40";
  }
  return configuration;
}

function audioConfiguration(track, contentType, spatialRendering = false) {
  return {
    contentType,
    channels: String(track?.channels || 2),
    bitrate: track?.bitRate || 384_000,
    samplerate: track?.sampleRate || 48_000,
    ...(spatialRendering ? { spatialRendering: true } : {}),
  };
}

export async function detectClientCapabilities(media, selectedAudioStreamIndex, dependencies = {}) {
  const videoElement = dependencies.videoElement
    || (typeof document !== "undefined" ? document.createElement("video") : null);
  const navigatorRef = dependencies.navigatorRef || (typeof navigator !== "undefined" ? navigator : null);
  const mediaSourceRef = dependencies.mediaSourceRef || (typeof MediaSource !== "undefined" ? MediaSource : null);
  const matchMediaRef = dependencies.matchMediaRef || (typeof matchMedia === "function" ? matchMedia : null);
  const tracks = Array.isArray(media?.audioTracks) ? media.audioTracks : [];
  const track = tracks.find((entry) => entry.index === Number(selectedAudioStreamIndex))
    || tracks.find((entry) => entry.default) || tracks[0] || null;
  const videoCodec = videoCodecString(media);
  const audioCodec = audioCodecString(track);
  const codecs = [videoCodec, audioCodec].filter(Boolean).join(", ");
  const directType = `${media?.sourceMimeType || "video/mp4"}${codecs ? `; codecs="${codecs}"` : ""}`;
  const fmp4Type = `video/mp4${codecs ? `; codecs="${codecs}"` : ""}`;
  const canPlay = (type) => statusFromCanPlay(videoElement?.canPlayType?.(type) || "");
  const directMedia = await decodingStatus(navigatorRef?.mediaCapabilities, {
    type: "file",
    video: videoConfiguration(media, `video/mp4; codecs="${videoCodec}"`),
    ...(track ? { audio: audioConfiguration(track, `audio/mp4; codecs="${audioCodec}"`) } : {}),
  });
  const mseMedia = await decodingStatus(navigatorRef?.mediaCapabilities, {
    type: "media-source",
    video: videoConfiguration(media, `video/mp4; codecs="${videoCodec}"`),
    ...(track ? { audio: audioConfiguration(track, `audio/mp4; codecs="${audioCodec}"`) } : {}),
  });
  const nativeHlsAnswer = videoElement?.canPlayType?.("application/vnd.apple.mpegurl") || "";
  const nativeHls = nativeHlsStatus(nativeHlsAnswer, navigatorRef);
  // MediaCapabilities file/MSE results do not describe a TV's native HLS
  // pipeline. When that pipeline and the exact codec both test positively,
  // keep the hardware HDR path available even if MSE itself is not smooth.
  const nativeHlsVideo = nativeHls === "supported"
    ? canPlay(`video/mp4; codecs="${videoCodec}"`) : "unknown";
  const nativeHlsAudio = nativeHls === "supported" && track
    ? canPlay(`audio/mp4; codecs="${audioCodec}"`) : "unknown";
  const mse = mediaSourceRef?.isTypeSupported
    ? (mediaSourceRef.isTypeSupported(fmp4Type) ? "supported" : "unsupported") : "unknown";
  const hdrDisplay = media.video?.hdrFormat && matchMediaRef
    ? (matchMediaRef("(dynamic-range: high)").matches ? "supported" : "unsupported") : "unknown";
  const videoStatus = performanceAwareStatus(
    canPlay(`video/mp4; codecs="${videoCodec}"`),
    directMedia,
    mseMedia,
    nativeHlsVideo,
  );
  const audioStatus = track ? performanceAwareStatus(
    canPlay(`audio/mp4; codecs="${audioCodec}"`),
    directMedia,
    mseMedia,
    nativeHlsAudio,
  ) : "supported";
  const atmosStatus = track?.atmos ? await decodingStatus(navigatorRef?.mediaCapabilities, {
    type: "file",
    audio: audioConfiguration(track, `audio/mp4; codecs="${audioCodec}"`, true),
  }) : "unknown";

  return {
    direct: playableContainer(canPlay(directType), directMedia),
    hls: strongest(nativeHls, mse),
    transport: { nativeHls, mse },
    video: {
      h264: media.videoCodec === "h264" ? videoStatus : canPlay('video/mp4; codecs="avc1.640028"'),
      hevc: media.videoCodec === "hevc" ? videoStatus : canPlay('video/mp4; codecs="hvc1"'),
      hdr: media.video?.hdrFormat ? both(videoStatus, hdrDisplay) : "supported",
      dolbyVision: media.video?.dolbyVision ? both(videoStatus, hdrDisplay) : "unknown",
    },
    audio: {
      aac: track?.codec === "aac" ? audioStatus : canPlay('audio/mp4; codecs="mp4a.40.2"'),
      ac3: track?.codec === "ac3" ? audioStatus : canPlay('audio/mp4; codecs="ac-3"'),
      eac3: track?.codec === "eac3" ? audioStatus : canPlay('audio/mp4; codecs="ec-3"'),
      truehd: track?.codec === "truehd" ? audioStatus : canPlay('audio/mp4; codecs="mlpa"'),
      atmos: atmosStatus,
    },
  };
}
