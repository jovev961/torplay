export function formatPlaybackTime(value) {
  const total = Math.max(0, Math.floor(Number(value) || 0));
  const seconds = String(total % 60).padStart(2, "0");
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

export function historyHref(item, mode = "resume") {
  const params = new URLSearchParams({ [mode]: "1" });
  if (item.mediaType === "tv") {
    params.set("season", String(item.seasonNumber));
    params.set("episode", String(item.episodeNumber));
  }
  return `${item.mediaType === "movie" ? "/movies" : "/shows"}/${item.tmdbId}?${params}`;
}

export function historyProgress(item) {
  if (item.completed) return 1;
  if (!(item.duration > 0)) return 0;
  return Math.max(0, Math.min(1, item.position / item.duration));
}

export function episodeCode(item) {
  return `S${String(item.seasonNumber).padStart(2, "0")}E${String(item.episodeNumber).padStart(2, "0")}`;
}

export function historyPrimaryAction(item) {
  const completed = Boolean(item.completed);
  return {
    label: completed ? "Play again" : "Resume",
    href: historyHref(item, completed ? "start" : "resume"),
  };
}
