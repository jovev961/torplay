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

export function isExtraMediaFile(file) {
  const value = String(file?.relativePath || file?.path || file?.name || "").toLowerCase();
  return /(?:^|[\\/._ -])(?:sample|samples|extras?|trailers?|featurettes?|behind.the.scenes)(?:[\\/._ -]|$)/i.test(value);
}

export function findEpisodeFile(files, season, episode, { allowSingleFileFallback = true } = {}) {
  if (!Array.isArray(files) || files.length === 0) return null;
  if (!Number.isInteger(season) || season < 0 || !Number.isInteger(episode) || episode < 1) {
    return null;
  }

  const eligible = files.filter((file) => !isExtraMediaFile(file));
  const exact = eligible.filter((file) => {
    const candidate = file?.relativePath || file?.path || file?.name;
    return matchesEpisode(candidate, season, episode);
  });
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  return allowSingleFileFallback && files.length === 1 && eligible.length === 1
    && !/(?:s\d{1,2}e\d{1,3}|\d{1,2}x\d{1,3})/i.test(eligible[0].name || "")
    ? eligible[0] : null;
}

export function findLargestFile(files) {
  if (!Array.isArray(files) || files.length === 0) return null;
  const eligible = files.filter((file) => !isExtraMediaFile(file));
  if (!eligible.length) return null;
  return eligible.reduce((largest, file) =>
    Number(file?.size) > Number(largest?.size) ? file : largest
  );
}
