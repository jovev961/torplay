import { XMLParser, XMLValidator } from "fast-xml-parser";
import { parseTorznabXml } from "./torznab-xml.js";

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", processEntities: false });
const array = (value) => value == null ? [] : Array.isArray(value) ? value : [value];

export function torznabEndpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Enter a valid Torznab API endpoint."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash || url.search) {
    throw new Error("Use an HTTP(S) API endpoint without credentials, query parameters, or fragments.");
  }
  return url.toString();
}

async function request(provider, parameters, { signal, fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  const url = new URL(torznabEndpoint(provider.endpoint));
  if (provider.apiKey) url.searchParams.set("apikey", provider.apiKey);
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, String(value));
  const deadline = AbortSignal.timeout(timeoutMs);
  const response = await fetchImpl(url, {
    headers: { Accept: "application/xml, application/rss+xml" }, cache: "no-store", redirect: "error",
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
  });
  if (!response.ok) throw new Error("Provider connection failed.");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Provider returned an empty response.");
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 2_000_000) throw new Error("Provider response is too large.");
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  const xml = Buffer.concat(chunks).toString("utf8");
  if (XMLValidator.validate(xml) !== true) throw new Error("Provider returned invalid XML.");
  const data = parser.parse(xml);
  if (data.error) throw new Error("Provider rejected the request or API key.");
  return { data, xml };
}

export async function testTorznab(provider, options = {}) {
  const { data } = await request(provider, { t: "caps" }, options);
  if (!data.caps?.searching) throw new Error("Provider did not return Torznab capabilities.");
  const modes = {};
  for (const [name, key] of [["search", "search"], ["movie", "movie-search"], ["tvsearch", "tv-search"]]) {
    const mode = data.caps.searching[key];
    const supported = String(mode?.supportedParams || "").split(",").map((item) => item.trim());
    if (mode?.available === "yes" && supported.some((item) => ["q", "imdbid"].includes(item))) modes[name] = supported;
  }
  const categories = array(data.caps.categories?.category).map((item) => Number(item.id));
  const mediaTypes = [
    ...(modes.movie || (modes.search?.includes("q") && categories.some((id) => id >= 2000 && id < 3000)) ? ["Movies"] : []),
    ...(modes.tvsearch || (modes.search?.includes("q") && categories.some((id) => id >= 5000 && id < 6000)) ? ["TV"] : []),
  ];
  if (!mediaTypes.length) throw new Error("Provider must support movie or TV searches.");
  const mode = Object.keys(modes).find((key) => modes[key].includes("q")) || Object.keys(modes)[0];
  const probe = await request(provider, { t: mode, limit: 1, ...(modes[mode].includes("q") ? { q: "Sintel" }
    : modes[mode].includes("imdbid") ? { imdbid: "1727587" } : {}) }, options);
  if (!probe.data.rss || !Object.hasOwn(probe.data.rss, "channel")) throw new Error("Provider did not return a valid search feed.");
  const advertisedLimit = Number(data.caps.limits?.max);
  return { modes, mediaTypes, limit: advertisedLimit > 0 ? Math.min(50, Math.floor(advertisedLimit)) : 50 };
}

export function customTorznabAdapter(provider) {
  return {
    id: provider.id, name: provider.name,
    async search(context, { signal } = {}) {
      const type = context.type === "show" ? "TV" : "Movies";
      if (context.type === "generic" && provider.genericEnabled === false) return [];
      if (context.type !== "generic" && provider.searchMediaTypes && !provider.searchMediaTypes.includes(type)) return [];
      if (context.type !== "generic" && !provider.capabilities.mediaTypes.includes(type)) return [];
      const modes = provider.capabilities.modes;
      const preferred = context.type === "show" ? "tvsearch" : context.type === "movie" ? "movie" : "search";
      const preferredSupported = modes[preferred];
      const mode = preferredSupported && (preferredSupported.includes("q") || context.imdbId)
        ? preferred : "search";
      const supported = modes[mode];
      if (!supported) return [];
      const parameters = { t: mode, limit: provider.capabilities.limit || 50 };
      if (supported.includes("q")) parameters.q = context.title || context.query;
      else if (supported.includes("imdbid") && context.imdbId) parameters.imdbid = context.imdbId.replace(/^tt/, "");
      else return [];
      if (context.type === "movie") parameters.cat = 2000;
      if (context.type === "show") {
        parameters.cat = 5000;
        if (supported.includes("season")) parameters.season = context.season;
        if (supported.includes("ep")) parameters.ep = context.episode;
        if (!supported.includes("season") && supported.includes("q")) parameters.q += ` S${String(context.season).padStart(2, "0")}`;
      }
      const variants = [parameters];
      if (parameters.ep !== undefined) { const season = { ...parameters }; delete season.ep; variants.push(season); }
      const settled = await Promise.allSettled(variants.map(async (params) => {
        const { data, xml } = await request(provider, params, { signal, timeoutMs: 120_000 });
        if (!data.rss || !Object.hasOwn(data.rss, "channel")) throw new Error("Invalid search feed.");
        return parseTorznabXml(xml).map((item) => ({ ...item, indexer: provider.name }));
      }));
      if (settled.every((item) => item.status === "rejected")) throw new Error("Torznab search failed.");
      return settled.filter((item) => item.status === "fulfilled").flatMap((item) => item.value);
    },
  };
}
