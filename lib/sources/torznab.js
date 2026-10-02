import { XMLParser, XMLValidator } from "fast-xml-parser";
import { request, endpointUrl } from "../network/request.js";
import { SourceError, text, integer } from "./contract.js";

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", processEntities: false });
const list = (value) => value == null ? [] : Array.isArray(value) ? value : [value];
const value = (input) => text(input?.["#text"] ?? input, 4096);

export function torznabEndpoint(input) {
  return endpointUrl(input, { protocols: ["http:", "https:"], base: true }).href;
}

async function xmlRequest(source, parameters, options = {}) {
  const url = new URL(torznabEndpoint(source.endpoint));
  if (source.apiKey) url.searchParams.set("apikey", source.apiKey);
  for (const [key, item] of Object.entries(parameters)) if (item != null) url.searchParams.set(key, String(item));
  const response = await (options.request || request)(url, { signal: options.signal,
    protocols: ["http:", "https:"], policy: "configured-service", sameOrigin: true,
    headers: { Accept: "application/xml, application/rss+xml" }, maxBytes: 2_000_000, timeoutMs: 15_000 });
  if ([401, 403].includes(response.status)) throw new SourceError("AUTHENTICATION_FAILED", "Indexer authentication failed.", 401);
  if (response.status !== 200) throw new SourceError("SOURCE_UNAVAILABLE", "The indexer could not be reached.", 502);
  const xml = response.body.toString("utf8");
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new SourceError("INVALID_RESPONSE", "The indexer returned invalid XML.");
  const data = parser.parse(xml);
  if (data.error) throw new SourceError("AUTHENTICATION_FAILED", "The indexer rejected the request.", 401);
  return data;
}

export async function verifyTorznab(source, options = {}) {
  const data = await xmlRequest(source, { t: "caps" }, options);
  if (!data.caps?.searching) throw new SourceError("INVALID_RESPONSE", "The indexer returned no search capabilities.");
  const modes = {};
  for (const [mode, field] of [["search", "search"], ["movie", "movie-search"], ["tvsearch", "tv-search"]]) {
    const advertised = data.caps.searching[field];
    const supported = String(advertised?.supportedParams || "").split(",").map((item) => item.trim());
    if (advertised?.available === "yes" && supported.some((item) => ["q", "imdbid"].includes(item))) modes[mode] = supported;
  }
  const categories = list(data.caps.categories?.category).map((item) => Number(item.id));
  const mediaTypes = [
    ...(modes.movie || (modes.search && categories.some((id) => id >= 2000 && id < 3000)) ? ["Movies"] : []),
    ...(modes.tvsearch || (modes.search && categories.some((id) => id >= 5000 && id < 6000)) ? ["TV"] : []),
  ];
  if (!mediaTypes.length) throw new SourceError("UNSUPPORTED_SOURCE", "The indexer does not advertise movie or TV search.");
  const mode = Object.keys(modes).find((name) => modes[name].includes("q")) || Object.keys(modes)[0];
  const probe = await xmlRequest(source, { t: mode, limit: 1,
    ...(modes[mode].includes("q") ? { q: "Sintel" } : { imdbid: "1727587" }) }, options);
  feedCandidates(probe, source);
  return { modes, mediaTypes, limit: Math.min(integer(data.caps.limits?.max) || 50, 50) };
}

function feedCandidates(data, source) {
  if (!data.rss || !Object.hasOwn(data.rss, "channel")) throw new SourceError("INVALID_RESPONSE", "The indexer returned an invalid search feed.");
  return list(data.rss.channel?.item).slice(0, 200).flatMap((item) => {
    const title = value(item.title);
    if (!title) return [];
    const attributes = Object.fromEntries(list(item["torznab:attr"]).map((attribute) => [attribute.name, attribute.value]));
    const links = [attributes.magneturl, item.magneturl, item.link, item.guid, ...list(item.enclosure).map((entry) => entry.url)].map(value);
    const magnet = links.find((link) => link.startsWith("magnet:"));
    const downloadUrl = links.find((link) => /^https?:/i.test(link));
    return [{ title, infoHash: attributes.infohash, size: item.size ?? attributes.size ?? list(item.enclosure)[0]?.length,
      seeders: attributes.seeders, leechers: attributes.leechers ?? (integer(attributes.peers) == null ? null
        : Math.max(0, integer(attributes.peers) - (integer(attributes.seeders) || 0))),
      origin: value(item.jackettindexer) || null,
      quality: attributes.quality, resolution: attributes.resolution, codec: attributes.codec,
      media: { imdbId: attributes.imdb ? `tt${String(attributes.imdb).replace(/^tt/, "")}` : null,
        tmdbId: attributes.tmdbid, year: attributes.year, season: attributes.season, episode: attributes.episode },
      locator: { magnet, downloadUrl, serviceOrigin: new URL(source.endpoint).origin } }];
  });
}

export async function searchTorznab(source, context, options = {}) {
  const mediaType = context.type === "show" ? "TV" : "Movies";
  if (context.type === "generic" && source.genericEnabled === false) return [];
  if (context.type !== "generic" && !(source.searchMediaTypes || source.capabilities?.mediaTypes || ["Movies", "TV"]).includes(mediaType)) return [];
  const modes = source.capabilities?.modes || { search: ["q"] };
  const preferred = context.type === "show" ? "tvsearch" : context.type === "movie" ? "movie" : "search";
  const mode = modes[preferred]?.some((key) => key === "q" || (key === "imdbid" && context.imdbId)) ? preferred : "search";
  const supported = modes[mode];
  if (!supported) return [];
  const parameters = { t: mode, limit: 50 };
  if (supported.includes("q")) parameters.q = context.title;
  else if (supported.includes("imdbid") && context.imdbId) parameters.imdbid = context.imdbId.slice(2);
  else return [];
  if (context.type !== "generic") parameters.cat = context.type === "show" ? 5000 : 2000;
  if (context.type === "show") {
    if (supported.includes("season")) parameters.season = context.season;
    if (supported.includes("ep")) parameters.ep = context.episode;
    if (parameters.q && !supported.includes("season")) parameters.q += ` S${String(context.season).padStart(2, "0")}E${String(context.episode).padStart(2, "0")}`;
  }
  const variants = [parameters];
  if (parameters.ep != null) { const pack = { ...parameters }; delete pack.ep; variants.push(pack); }
  else if (context.type === "show" && parameters.q && !supported.includes("season")) {
    variants.push({ ...parameters, q: `${context.title} S${String(context.season).padStart(2, "0")}` });
  }
  const settled = await Promise.allSettled(variants.map(async (variant) => feedCandidates(await xmlRequest(source, variant, options), source)));
  options.signal?.throwIfAborted();
  const successes = settled.filter((item) => item.status === "fulfilled");
  if (!successes.length) throw settled[0].reason;
  return successes.flatMap((item) => item.value);
}

export function jackettSource(record, environment = process.env) {
  if (!/^[a-z\d][a-z\d._-]{0,99}$/i.test(record.indexerId || "")) throw new SourceError("CONFIGURATION_REQUIRED", "Choose a valid Jackett indexer.", 400);
  const apiKey = String(environment.JACKETT_API_KEY || "").trim();
  if (!environment.JACKETT_URL || !apiKey || apiKey === "replace-me") throw new SourceError("CONFIGURATION_REQUIRED", "Configure the external Jackett service.", 400);
  const base = new URL(torznabEndpoint(environment.JACKETT_URL));
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/api/v2.0/indexers/${record.indexerId}/results/torznab/api`;
  return { ...record, endpoint: base.href, apiKey };
}

export async function listJackettIndexers({ environment = process.env, ...options } = {}) {
  const source = jackettSource({ indexerId: "all" }, environment);
  const data = await xmlRequest(source, { t: "indexers", configured: "true" }, options);
  if (!Object.hasOwn(data, "indexers")) throw new SourceError("INVALID_RESPONSE", "Jackett returned no indexer list.");
  return list(data.indexers?.indexer).filter((item) => /^[a-z\d][a-z\d._-]{0,99}$/i.test(item.id || ""))
    .map((item) => ({ id: String(item.id), name: text(item.title || item.name || item.id, 100) }));
}
