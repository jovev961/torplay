const HAVE_CURRENT_DATA = 2;
const DEFAULT_SEEK_TOLERANCE_SECONDS = 1.5;

function synchronizedPositionReady(video, target, tolerance) {
  const position = Number(video?.currentTime);
  return Boolean(video)
    && !video.seeking
    && Number.isFinite(position)
    && Math.abs(position - target) < tolerance
    && Number(video.readyState) >= HAVE_CURRENT_DATA;
}

export function waitForSynchronizedPosition(video, target, {
  timeoutMs = 15_000,
  tolerance = DEFAULT_SEEK_TOLERANCE_SECONDS,
} = {}) {
  const position = Number(target);
  if (!video || !Number.isFinite(position) || position < 0) {
    return Promise.reject(new Error("The shared playback position is invalid."));
  }
  if (synchronizedPositionReady(video, position, tolerance)) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const readinessEvents = ["seeked", "loadeddata", "canplay"];
    const timer = setTimeout(() => {
      finish(new Error("The local source did not reach the shared position in time."));
    }, timeoutMs);
    const onReady = () => {
      if (synchronizedPositionReady(video, position, tolerance)) finish();
    };
    const onError = () => finish(new Error("The local source could not seek to the shared position."));

    function finish(error) {
      clearTimeout(timer);
      for (const event of readinessEvents) video.removeEventListener(event, onReady);
      video.removeEventListener("error", onError);
      if (error) reject(error);
      else resolve();
    }

    for (const event of readinessEvents) video.addEventListener(event, onReady);
    video.addEventListener("error", onError, { once: true });
    queueMicrotask(onReady);
  });
}
