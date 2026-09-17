export function safeTorrentRelativePath(value, fallback = "") {
  const raw = typeof value === "string" ? value : "";
  if (!raw || raw.length > 1024 || raw.includes("\0")) return fallback;

  const normalized = raw.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[a-z]:\//i.test(normalized)) return fallback;

  const segments = normalized.split("/");
  if (segments.some((segment) =>
    !segment || segment === "." || segment === ".." || /[\u0000-\u001f\u007f]/.test(segment)
  )) {
    return fallback;
  }
  return segments.join("/");
}

export function matchesEpisode(value, season, episode) {
  if (typeof value !== "string") return false;
  if (!Number.isInteger(season) || season < 0 || !Number.isInteger(episode) || episode < 1) {
    return false;
  }

  const tokenSeparator = "[\\s._-]*";
  const pathSeparator = "[\\s._/\\\\-]*";
  return [
    new RegExp(`(?:^|[^a-z\\d])s0*${season}${tokenSeparator}e0*${episode}(?!\\d)`, "i"),
    new RegExp(`(?:^|[^a-z\\d])0*${season}${tokenSeparator}x${tokenSeparator}0*${episode}(?!\\d)`, "i"),
    new RegExp(`(?:^|[^a-z\\d])season${pathSeparator}0*${season}${pathSeparator}episode${pathSeparator}0*${episode}(?!\\d)`, "i"),
  ].some((pattern) => pattern.test(value));
}

export function findEpisodeFile(files, season, episode, { allowSingleFileFallback = true } = {}) {
  if (!Array.isArray(files) || files.length === 0) return null;
  if (!Number.isInteger(season) || season < 0 || !Number.isInteger(episode) || episode < 1) {
    return null;
  }

  const exact = files.find((file) => {
    const candidate = file?.relativePath || file?.path || file?.name;
    return matchesEpisode(candidate, season, episode);
  });
  return exact ?? (allowSingleFileFallback && files.length === 1 ? files[0] : null);
}

export function findLargestFile(files) {
  if (!Array.isArray(files) || files.length === 0) return null;
  return files.reduce((largest, file) =>
    Number(file?.size) > Number(largest?.size) ? file : largest
  );
}
