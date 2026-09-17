import { XMLParser, XMLValidator } from "fast-xml-parser";
import { saveSearchResult } from "./result-store.js";

const MAX_QUERY_LENGTH = 200;
const SEARCH_TIMEOUT_MS = 120_000;
const INDEXER_ID_PATTERN = /^[a-z\d][a-z\d._-]{0,99}$/i;
const INDEXER_SETTINGS = {
  movie: "JACKETT_MOVIE_INDEXERS",
  show: "JACKETT_SHOW_INDEXERS",
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  processEntities: false,
  trimValues: true,
});

export class JackettSearchError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "JackettSearchError";
    this.status = status;
  }
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function asText(value) {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (value && typeof value === "object" && "#text" in value) return String(value["#text"]);
  return "";
}

function safeInteger(value) {
  const parsed = Number.parseInt(asText(value), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function safeUrl(value, protocols) {
  const raw = asText(value).trim();
  if (!raw) return null;

  try {
    const url = new URL(raw);
    return protocols.includes(url.protocol) ? raw : null;
  } catch {
    return null;
  }
}

function itemAttributes(item) {
  return new Map(
    asArray(item["torznab:attr"])
      .filter((attribute) => attribute && typeof attribute === "object")
      .map((attribute) => [String(attribute.name ?? "").toLowerCase(), attribute.value]),
  );
}

function enclosureUrl(item) {
  const enclosure = asArray(item.enclosure)[0];
  return enclosure && typeof enclosure === "object" ? enclosure.url : null;
}

function normalizeInfoHash(value) {
  const hash = asText(value).trim();
  if (/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(hash)) return hash.toLowerCase();
  if (/^[a-z2-7]{32}$/i.test(hash)) return hash.toUpperCase();
  return null;
}

function infoHashFromMagnet(magnet) {
  if (!magnet) return null;
  try {
    const exactTopic = new URL(magnet).searchParams
      .getAll("xt")
      .find((topic) => topic.toLowerCase().startsWith("urn:btih:"));
    return normalizeInfoHash(exactTopic?.slice("urn:btih:".length));
  } catch {
    return null;
  }
}

export function validateSearchQuery(value) {
  const query = typeof value === "string" ? value.trim() : "";
  if (!query) throw new JackettSearchError("Enter a search term.", 400);
  if (query.length > MAX_QUERY_LENGTH) {
    throw new JackettSearchError(
      `Search terms must be ${MAX_QUERY_LENGTH} characters or fewer.`,
      400,
    );
  }
  return query;
}

export function parseJackettXml(xml) {
  if (XMLValidator.validate(xml) !== true) {
    throw new JackettSearchError("Jackett returned invalid XML.", 502);
  }

  let document;
  try {
    document = parser.parse(xml);
  } catch {
    throw new JackettSearchError("Jackett returned invalid XML.", 502);
  }

  const items = asArray(document?.rss?.channel?.item);
  return items.map((item) => {
    const attributes = itemAttributes(item);
    const links = [
      attributes.get("magneturl"),
      item.magneturl,
      item.link,
      item.guid,
      enclosureUrl(item),
    ];
    const magnet = links.map((value) => safeUrl(value, ["magnet:"])).find(Boolean) ?? null;
    const downloadUrl = [item.link, item.guid, enclosureUrl(item)]
      .map((value) => safeUrl(value, ["http:", "https:"]))
      .find(Boolean) ?? null;
    const infoHash = normalizeInfoHash(attributes.get("infohash")) ?? infoHashFromMagnet(magnet);
    const title = asText(item.title).trim() || "Untitled torrent";
    const id = saveSearchResult({ magnet, downloadUrl, releaseName: title });

    return {
      id,
      title,
      size: safeInteger(item.size ?? attributes.get("size")),
      seeders: safeInteger(attributes.get("seeders")),
      magnet,
      infoHash,
      indexer: asText(item.jackettindexer).trim() || "Unknown indexer",
      canStart: Boolean(magnet || downloadUrl),
    };
  });
}

export function parseIndexerIds(value, settingName) {
  const ids = [...new Set(
    String(value ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  )];

  const invalid = ids.find((id) => !INDEXER_ID_PATTERN.test(id));
  if (invalid) {
    throw new JackettSearchError(
      `${settingName} contains an invalid Jackett indexer ID.`,
      500,
    );
  }
  return ids;
}

function indexersForType(type) {
  if (type === "movie" || type === "show") {
    const settingName = INDEXER_SETTINGS[type];
    const ids = parseIndexerIds(process.env[settingName], settingName);
    return ids.length > 0 ? ids : ["all"];
  }

  const movieIds = parseIndexerIds(
    process.env.JACKETT_MOVIE_INDEXERS,
    "JACKETT_MOVIE_INDEXERS",
  );
  const showIds = parseIndexerIds(
    process.env.JACKETT_SHOW_INDEXERS,
    "JACKETT_SHOW_INDEXERS",
  );
  const ids = [...new Set([...movieIds, ...showIds])];
  return ids.length > 0 ? ids : ["all"];
}

function jackettConfig(type) {
  const baseUrl = process.env.JACKETT_URL?.trim();
  const apiKey = process.env.JACKETT_API_KEY?.trim();
  if (!baseUrl || !apiKey) {
    throw new JackettSearchError(
      "Jackett is not configured. Add JACKETT_URL and JACKETT_API_KEY to .env.local.",
      500,
    );
  }

  let base;
  try {
    base = new URL(`${baseUrl.replace(/\/+$/, "")}/`);
  } catch {
    throw new JackettSearchError("JACKETT_URL must be a valid URL.", 500);
  }
  if (!["http:", "https:"].includes(base.protocol)) {
    throw new JackettSearchError("JACKETT_URL must use HTTP or HTTPS.", 500);
  }
  return { base, apiKey, indexerIds: indexersForType(type) };
}

function searchParameters(type, season, episode) {
  if (type === "movie") return { t: "movie", cat: "2000" };
  if (type === "show") {
    if (!Number.isInteger(season) || season < 0 || !Number.isInteger(episode) || episode < 1) {
      throw new JackettSearchError("A valid season and episode are required for show searches.", 400);
    }
    return { t: "tvsearch", cat: "5000", season: String(season), ep: String(episode) };
  }
  if (type && type !== "generic") {
    throw new JackettSearchError("Search type must be movie or show.", 400);
  }
  return { t: "search" };
}

async function requestJackett(query, parameters, indexerId, config) {
  const { base, apiKey } = config;
  const torznabPath = `api/v2.0/indexers/${indexerId}/results/torznab/api`;
  const url = new URL(torznabPath, base);
  url.searchParams.set("apikey", apiKey);
  for (const [name, value] of Object.entries(parameters)) {
    url.searchParams.set(name, value);
  }
  url.searchParams.set("q", query);
  url.searchParams.set("limit", "50");

  let response;
  try {
    response = await fetch(url, {
      headers: { Accept: "application/rss+xml, application/xml, text/xml" },
      cache: "no-store",
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
  } catch (error) {
    if (error?.name === "TimeoutError") {
      throw new JackettSearchError("Jackett did not respond before the request timed out.", 504);
    }
    throw new JackettSearchError(
      "Could not reach Jackett. Check that the container is running on JACKETT_URL.",
      502,
    );
  }

  if (!response.ok) {
    const detail = response.status === 401 || response.status === 403
      ? " Check JACKETT_API_KEY."
      : "";
    throw new JackettSearchError(`Jackett returned HTTP ${response.status}.${detail}`, 502);
  }
  return parseJackettXml(await response.text());
}

function uniqueResults(results) {
  const seen = new Set();
  return results.filter((result) => {
    const key = result.infoHash || `${result.title.toLowerCase()}\u0000${result.size}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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

function failedIndexerSearch(reasons) {
  if (reasons.every((error) => error?.status === 504)) {
    return new JackettSearchError("All configured Jackett indexers timed out.", 504);
  }
  const authenticationError = reasons.find((error) => error?.message?.includes("JACKETT_API_KEY"));
  if (authenticationError) return authenticationError;
  return new JackettSearchError(
    "No configured Jackett indexer completed the search. Check Jackett and indexer settings.",
    502,
  );
}

async function searchIndexers(query, parameterSets, config) {
  const requests = config.indexerIds.flatMap((indexerId) =>
    parameterSets.map((parameters) => requestJackett(query, parameters, indexerId, config))
  );
  const settled = await Promise.allSettled(requests);
  const successful = settled
    .filter((result) => result.status === "fulfilled")
    .flatMap((result) => result.value);

  if (settled.some((result) => result.status === "fulfilled")) {
    return uniqueResults(successful);
  }
  throw failedIndexerSearch(settled.map((result) => result.reason));
}

export async function searchJackett(input, options = {}) {
  const query = validateSearchQuery(input);
  const type = options.type || "generic";
  const season = Number(options.season);
  const episode = Number(options.episode);
  const parameters = searchParameters(type, season, episode);
  const config = jackettConfig(type);

  if (type !== "show") {
    const results = await searchIndexers(query, [parameters], config);
    return filterAndRankResults(results, { type, query });
  }

  const seasonParameters = { ...parameters };
  delete seasonParameters.ep;
  const results = await searchIndexers(query, [parameters, seasonParameters], config);
  return filterAndRankResults(results, { type, query, season, episode });
}
