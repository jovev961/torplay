export class TorrentSearchError extends Error {
  constructor(message, status, code = null) {
    super(message);
    this.name = "TorrentSearchError";
    this.status = status;
    this.code = code;
  }
}

const MAX_QUERY_LENGTH = 200;

export function validateSearchQuery(value) {
  const query = typeof value === "string" ? value.trim() : "";
  if (!query) throw new TorrentSearchError("Enter a search term.", 400);
  if (query.length > MAX_QUERY_LENGTH) {
    throw new TorrentSearchError(
      `Search terms must be ${MAX_QUERY_LENGTH} characters or fewer.`,
      400,
    );
  }
  return query;
}

export function searchContext(mediaContext) {
  const query = validateSearchQuery(mediaContext.title);
  const type = mediaContext.type || "generic";
  if (!["generic", "movie", "show"].includes(type)) {
    throw new TorrentSearchError("Search type must be movie or show.", 400);
  }
  const season = Number(mediaContext.season);
  const episode = Number(mediaContext.episode);
  if (type === "show" && (!Number.isInteger(season) || season < 0 || !Number.isInteger(episode) || episode < 1)) {
    throw new TorrentSearchError("A valid season and episode are required for show searches.", 400);
  }
  return { query, type, season, episode };
}

export function uniqueResults(results) {
  const unique = new Map();
  for (const result of results) {
    const key = result.infoHash || `${result.title.toLowerCase()}\u0000${result.size}`;
    const current = unique.get(key);
    if (!current || compareDuplicateSources(result, current) < 0) unique.set(key, result);
  }
  return [...unique.values()];
}

function sourceCapability(result) {
  if (result.source?.torrentInput) return 4;
  if (result.source?.downloadUrl) return 3;
  if (result.source?.resolver) return 2;
  if (result.source?.magnet) return 1;
  return 0;
}

function knownSize(result) {
  return result.size > 0 ? result.size : Number.POSITIVE_INFINITY;
}

function compareDuplicateSources(left, right) {
  return sourceCapability(right) - sourceCapability(left)
    || (right.seeders ?? 0) - (left.seeders ?? 0)
    || (right.leechers ?? 0) - (left.leechers ?? 0)
    || knownSize(left) - knownSize(right)
    || String(left.providerId ?? left.indexer ?? "").localeCompare(String(right.providerId ?? right.indexer ?? ""))
    || String(left.title ?? "").localeCompare(String(right.title ?? ""));
}

function normalizeReleaseTitle(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/^(?:\s*\[[^\]]+\]\s*)+/, "")
    .replace(/&/g, " and ")
    .replace(/[.'’]/g, "")
    .replace(/[^a-z\d]+/gi, " ")
    .trim()
    .toLowerCase();
}

function withoutLeadingArticle(value) {
  return value.replace(/^(?:a|an|the)\s+/, "");
}

function titleMatches(releaseTitle, query) {
  const normalizedRelease = normalizeReleaseTitle(releaseTitle);
  const normalizedQuery = normalizeReleaseTitle(query);
  const releases = new Set([normalizedRelease, withoutLeadingArticle(normalizedRelease)]);
  const queries = new Set([normalizedQuery, withoutLeadingArticle(normalizedQuery)]);

  return [...releases].some((release) =>
    [...queries].some((candidate) =>
      candidate && (release === candidate || release.startsWith(`${candidate} `))
    )
  );
}

function episodeOrSeasonMatches(title, season, episode) {
  const separator = "[\\s._-]*";
  const exactEpisode = [
    new RegExp(`(?:^|[^a-z\\d])s0*${season}${separator}e0*${episode}(?!\\d)`, "i"),
    new RegExp(`(?:^|[^\\d])0*${season}${separator}x${separator}0*${episode}(?!\\d)`, "i"),
    new RegExp(`season${separator}0*${season}${separator}episode${separator}0*${episode}(?!\\d)`, "i"),
  ].some((pattern) => pattern.test(title));
  if (exactEpisode) return true;

  const containsEpisode = /(?:^|[^a-z\d])s\d+[\s._-]*e\d+|(?:^|[^\d])\d+[\s._-]*x[\s._-]*\d+|season[\s._-]*\d+[\s._-]*episode[\s._-]*\d+/i
    .test(title);
  if (containsEpisode) return false;

  return [
    new RegExp(`(?:^|[^a-z\\d])s0*${season}(?!\\d)`, "i"),
    new RegExp(`season${separator}0*${season}(?!\\d)`, "i"),
  ].some((pattern) => pattern.test(title));
}

function resultSize(result) {
  return result.size > 0 ? result.size : Number.POSITIVE_INFINITY;
}

export function filterAndRankResults(results, context = {}) {
  const type = context.type || "generic";
  let filtered = results;

  if (type === "movie") {
    filtered = results.filter((result) => titleMatches(result.title, context.query));
  } else if (type === "show") {
    filtered = results.filter((result) =>
      titleMatches(result.title, context.query)
      && episodeOrSeasonMatches(result.title, context.season, context.episode)
    );
  }

  return [...filtered].sort((left, right) =>
    right.seeders - left.seeders
    || resultSize(left) - resultSize(right)
    || left.title.localeCompare(right.title)
  );
}
