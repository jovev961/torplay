import { XMLParser, XMLValidator } from "fast-xml-parser";
import { searchContext } from "./processing.js";
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

    return {
      title,
      size: safeInteger(item.size ?? attributes.get("size")),
      seeders: safeInteger(attributes.get("seeders")),
      leechers: attributes.has("leechers") ? safeInteger(attributes.get("leechers"))
        : attributes.has("peers") ? Math.max(0, safeInteger(attributes.get("peers")) - safeInteger(attributes.get("seeders"))) : null,
      quality: asText(attributes.get("quality")) || null,
      resolution: asText(attributes.get("resolution")) || null,
      codec: asText(attributes.get("codec")) || null,
      media: {
        tmdbId: attributes.get("tmdbid") ?? null,
        imdbId: attributes.has("imdb") ? `tt${asText(attributes.get("imdb")).replace(/^tt/, "")}` : null,
        year: attributes.get("year") ?? null,
        season: attributes.get("season") ?? null,
        episode: attributes.get("episode") ?? null,
      },
      source: { magnet, downloadUrl, releaseName: title },
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
      "Jackett is not configured. Complete TorPlay setup or update Settings on this computer.",
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
    return { t: "tvsearch", cat: "5000", season: String(season), ep: String(episode) };
  }
  return { t: "search" };
}

async function requestJackett(query, parameters, indexerId, config, signal) {
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
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(SEARCH_TIMEOUT_MS)]) : AbortSignal.timeout(SEARCH_TIMEOUT_MS),
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

async function searchIndexers(query, parameterSets, config, signal) {
  const requests = config.indexerIds.flatMap((indexerId) =>
    parameterSets.map((parameters) => requestJackett(query, parameters, indexerId, config, signal))
  );
  const settled = await Promise.allSettled(requests);
  const successful = settled
    .filter((result) => result.status === "fulfilled")
    .flatMap((result) => result.value);

  if (settled.some((result) => result.status === "fulfilled")) {
    return successful;
  }
  throw failedIndexerSearch(settled.map((result) => result.reason));
}

// Adapter output is internal: source references never cross the search service boundary.
export async function searchJackett(mediaContext, { signal } = {}) {
  const { query, type, season, episode } = searchContext(mediaContext);
  const parameters = searchParameters(type, season, episode);
  const config = jackettConfig(type);
  if (type !== "show") return searchIndexers(query, [parameters], config, signal);
  const seasonParameters = { ...parameters };
  delete seasonParameters.ep;
  return searchIndexers(query, [parameters, seasonParameters], config, signal);
}
