const INLINE_EPISODE_PATTERNS = [
  /(?:^|[^a-z\d])s0*(\d+)[\s._-]*e0*(\d+)(?!\d)/i,
  /(?:^|[^a-z\d])0*(\d+)[\s._-]*x[\s._-]*0*(\d+)(?!\d)/i,
];

const PATH_EPISODE_PATTERN = /(?:^|[^a-z\d])season[\s._/\\-]*0*(\d+)[\s._/\\-]*episode[\s._/\\-]*0*(\d+)(?!\d)/i;
const TECHNICAL_BOUNDARY = /(?:^|\s)(?:4320p|2160p|1440p|1080p|720p|576p|480p|360p|uhd|bluray|blu-ray|brrip|web(?:-?dl|rip)?|hdtv|dvdrip|remux|proper|repack|hevc|h\.?265|x265|h\.?264|x264|av1|vp9|10bit|8bit|hdr10?|dv|dolby|ddp?\d*(?:\.\d+)?|eac3|ac3|aac\d*(?:\.\d+)?|dts(?:-?hd)?)(?:\s|$)/i;

function sourceName(file) {
  return file?.relativePath || file?.path || file?.name || "";
}

function baseName(value) {
  return String(value || "").replaceAll("\\", "/").split("/").at(-1) || "";
}

function withoutExtension(value) {
  return value.replace(/\.[a-z\d]{2,5}$/i, "");
}

export function parseEpisodeIdentity(value) {
  if (typeof value !== "string") return null;
  for (const pattern of [...INLINE_EPISODE_PATTERNS, PATH_EPISODE_PATTERN]) {
    const match = pattern.exec(value);
    if (!match) continue;
    const season = Number(match[1]);
    const episode = Number(match[2]);
    if (Number.isInteger(season) && season >= 0 && Number.isInteger(episode) && episode >= 1) {
      return { season, episode };
    }
  }
  return null;
}

export function formatEpisodeCode(season, episode) {
  if (!Number.isInteger(season) || season < 0 || !Number.isInteger(episode) || episode < 1) {
    return null;
  }
  return `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
}

export function parseEpisodeTitle(value) {
  const filename = withoutExtension(baseName(value));
  const match = INLINE_EPISODE_PATTERNS.map((pattern) => pattern.exec(filename)).find(Boolean);
  if (!match) return null;
  let title = filename.slice(match.index + match[0].length)
    .replace(/^[\s._-]+/, "")
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const boundary = TECHNICAL_BOUNDARY.exec(title);
  if (boundary) title = title.slice(0, boundary.index).trim();
  title = title.replace(/[\s._-]+$/, "").trim();
  if (!title || /^(?:episode|video|file)(?:\s+\d+)?$/i.test(title)) return null;
  return title;
}

function resolution(value) {
  const match = /(?:^|[^a-z\d])(4320p|2160p|1440p|1080p|720p|576p|480p|360p)(?![a-z\d])/i.exec(value);
  return match?.[1]?.toLowerCase() || null;
}

function videoCodec(value) {
  const codecs = [
    [/(?:^|[^a-z\d])av1(?![a-z\d])/i, "AV1"],
    [/(?:^|[^a-z\d])(?:hevc|h\.?265|x265)(?![a-z\d])/i, "HEVC"],
    [/(?:^|[^a-z\d])(?:h\.?264|x264|avc)(?![a-z\d])/i, "H.264"],
    [/(?:^|[^a-z\d])vp9(?![a-z\d])/i, "VP9"],
  ];
  return codecs.find(([pattern]) => pattern.test(value))?.[1] || null;
}

function container(value) {
  const extension = /\.([a-z\d]{2,5})$/i.exec(value)?.[1];
  return extension?.toUpperCase() || null;
}

export function formatFileSize(value) {
  if (!Number.isFinite(value) || value < 0) return "Unknown size";
  if (value === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unit = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const amount = value / 1024 ** unit;
  return `${amount >= 10 || unit === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`;
}

export function episodeFilePresentation(file, episodes = []) {
  const fullPath = sourceName(file);
  const filename = file?.name || baseName(fullPath) || "Unknown video file";
  const identity = parseEpisodeIdentity(fullPath);
  const metadata = identity
    ? episodes.find((episode) => (
      Number(episode?.season) === identity.season && Number(episode?.number) === identity.episode
    ))
    : null;
  const code = identity ? formatEpisodeCode(identity.season, identity.episode) : null;
  const title = metadata?.title?.trim()
    || parseEpisodeTitle(filename)
    || (identity ? `Episode ${identity.episode}` : "Unidentified episode");
  const codec = videoCodec(fullPath);
  const technical = [resolution(fullPath), codec || container(filename), formatFileSize(file?.size)]
    .filter(Boolean);

  return {
    code,
    title,
    technical,
    filename,
    fullPath: fullPath || filename,
    recognized: Boolean(identity),
  };
}

export function episodeFileCardModel(display) {
  return {
    primary: display.recognized
      ? `${display.code ? `${display.code} · ` : ""}${display.title}` : display.filename,
    expandable: !display.recognized && display.fullPath.length > 48,
  };
}
