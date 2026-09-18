export function activeSubtitleCues(cues, playbackPosition, delaySeconds = 0) {
  const position = Number(playbackPosition);
  const delay = Number(delaySeconds);
  if (!Number.isFinite(position) || !Number.isFinite(delay)) return [];

  const cueTime = position - delay;
  return Array.from(cues || []).filter((cue) => {
    const start = Number(cue?.startTime);
    const end = Number(cue?.endTime);
    return Number.isFinite(start)
      && Number.isFinite(end)
      && end > start
      && start <= cueTime
      && cueTime < end;
  });
}

export function subscribeToSubtitleTrack(element, {
  mode = "disabled",
  onCues,
  onError,
} = {}) {
  const track = element?.track;
  if (!track) return () => {};

  let synced = false;
  const syncCues = () => {
    synced = true;
    onCues?.(Array.from(track.cues || []));
  };
  const handleError = () => onError?.();

  element.addEventListener("load", syncCues);
  element.addEventListener("error", handleError);
  track.mode = mode;

  if (element.readyState === 2 && !synced) syncCues();
  else if (element.readyState === 3) handleError();

  return () => {
    element.removeEventListener("load", syncCues);
    element.removeEventListener("error", handleError);
  };
}
