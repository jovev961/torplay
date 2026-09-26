const RETRYABLE_AUDIO_CODECS = new Set(["eac3", "ac3"]);
const PRESERVED_VIDEO_ACTIONS = new Set(["copy", "use-compatible-base-layer"]);

export function nextPlaybackFallback(details, current = {}) {
  const failedStrategies = Array.isArray(current.failedStrategies) ? current.failedStrategies : [];
  const failedAudioCodecs = Array.isArray(current.failedAudioCodecs) ? current.failedAudioCodecs : [];
  const strategy = details?.strategy;
  const plan = details?.playbackPlan;
  const audioCodec = plan?.output?.audioCodec;

  if (strategy === "selective-transcode"
    && PRESERVED_VIDEO_ACTIONS.has(plan?.videoAction)
    && RETRYABLE_AUDIO_CODECS.has(audioCodec)
    && !failedAudioCodecs.includes(audioCodec)) {
    return {
      retry: true,
      failedStrategies,
      failedAudioCodecs: [...failedAudioCodecs, audioCodec],
    };
  }

  if (!strategy || strategy === "compatibility-transcode" || failedStrategies.includes(strategy)) {
    return { retry: false, failedStrategies, failedAudioCodecs };
  }

  return {
    retry: true,
    failedStrategies: [...failedStrategies, strategy],
    failedAudioCodecs,
  };
}
