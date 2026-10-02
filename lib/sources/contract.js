import { endpointUrl } from "../network/request.js";

export class SourceError extends Error {
  constructor(code, message, status = 422) {
    super(message);
    this.name = "SourceError";
    this.code = code;
    this.status = status;
  }
}

export function text(value, maximum = 300) {
  return typeof value === "string" || typeof value === "number"
    ? String(value).replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, maximum) : "";
}

export function integer(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

export function mediaContext(input = {}) {
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (!title || title.length > 200 || /[\x00-\x1f]/.test(title)) {
    throw new SourceError("INVALID_SEARCH", "Enter a search title up to 200 characters.", 400);
  }
  const type = input.type || "generic";
  if (!["generic", "movie", "show"].includes(type)) throw new SourceError("INVALID_SEARCH", "Choose a valid media type.", 400);
  const season = integer(input.season);
  const episode = integer(input.episode);
  if (type === "show" && (season === null || !episode)) throw new SourceError("INVALID_SEARCH", "A valid season and episode are required.", 400);
  const aliases = [...new Set([title, input.originalTitle, ...(Array.isArray(input.aliases) ? input.aliases : [])]
    .filter((value) => typeof value === "string" && value.trim() && value.length <= 200).map((value) => value.trim()))].slice(0, 5);
  return { title, type, aliases, tmdbId: integer(input.tmdbId), year: integer(input.year),
    imdbId: /^tt\d+$/.test(input.imdbId || "") ? input.imdbId : null,
    season: type === "show" ? season : null, episode: type === "show" ? episode : null,
    categories: Array.isArray(input.categories) ? input.categories.map((value) => text(value, 100)).slice(0, 20) : [] };
}

export function infoHash(value) {
  const hash = text(value, 64);
  if (/^[a-f\d]{40}$/i.test(hash)) return hash.toLowerCase();
  if (!/^[a-z2-7]{32}$/i.test(hash)) return null;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, accumulator = 0;
  const bytes = [];
  for (const character of hash.toUpperCase()) {
    accumulator = (accumulator << 5) | alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((accumulator >>> bits) & 255); }
  }
  return Buffer.from(bytes).toString("hex");
}

export function magnetSource(value, fallbackHash) {
  let hash = infoHash(fallbackHash);
  let url;
  try {
    url = new URL(value);
    if (url.protocol !== "magnet:" || url.username || url.password) url = null;
    if (url) {
      const topic = url.searchParams.getAll("xt").find((item) => /^urn:btih:/i.test(item));
      hash = infoHash(topic?.slice(9));
      if (!hash) url = null;
    }
  } catch { url = null; }
  return { infoHash: hash, magnet: url?.href || (hash ? `magnet:?xt=urn:btih:${hash}` : null) };
}

export function normalize(raw, source) {
  if (!raw || typeof raw !== "object") return null;
  const title = text(raw.title);
  if (!title) return null;
  const locator = raw.locator || {};
  const torrent = magnetSource(locator.magnet, raw.infoHash);
  let downloadUrl = null;
  if (locator.downloadUrl) {
    try { downloadUrl = endpointUrl(locator.downloadUrl, { protocols: ["http:", "https:"] }).href; }
    catch { /* Invalid locators do not cross the source boundary. */ }
  }
  const resolver = typeof locator.resolve === "function" ? locator.resolve : null;
  if (!torrent.magnet && !downloadUrl && !resolver) return null;
  const reported = raw.media || {};
  return {
    kind: "torrent", title, size: integer(raw.size), seeders: integer(raw.seeders), leechers: integer(raw.leechers),
    sourceId: source.id, sourceName: text(source.name, 100), origin: text(raw.origin, 100) || null,
    quality: text(raw.quality, 50) || null, resolution: text(raw.resolution, 50) || null, codec: text(raw.codec, 50) || null,
    media: { type: ["movie", "show"].includes(reported.type) ? reported.type : null,
      imdbId: /^tt\d+$/.test(reported.imdbId || "") ? reported.imdbId : null,
      tmdbId: integer(reported.tmdbId), year: integer(reported.year), season: integer(reported.season), episode: integer(reported.episode) },
    infoHash: torrent.infoHash,
    locator: { magnet: torrent.magnet, downloadUrl, resolve: resolver,
      serviceOrigin: locator.serviceOrigin || null },
  };
}

export function diagnostic(error) {
  const code = error?.code;
  const state = ["CARDIGANN_UNSUPPORTED", "UNSUPPORTED_SOURCE"].includes(code) ? "unsupported"
    : code === "CONFIGURATION_REQUIRED" ? "configuration-required"
    : code === "FLARESOLVERR_NOT_CONFIGURED" ? "requires-flaresolverr"
    : error?.status === 401 || code === "AUTHENTICATION_FAILED" ? "authentication-failed"
    : error?.name === "TimeoutError" || error?.status === 504 ? "timed-out"
    : code === "INVALID_RESPONSE" ? "invalid-response" : "unavailable";
  const messages = { unsupported: "This definition requires unsupported features.",
    "configuration-required": "Complete this source's configuration.", "requires-flaresolverr": "Requires FlareSolverr.",
    "authentication-failed": "Source authentication failed.", "timed-out": "Source search timed out.",
    "invalid-response": "The source returned an invalid response.", unavailable: "The source could not be searched." };
  return { status: state, message: messages[state], code: /^[A-Z][A-Z0-9_]{0,60}$/.test(code || "") ? code : "SOURCE_UNAVAILABLE" };
}
