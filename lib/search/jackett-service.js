import { XMLParser, XMLValidator } from "fast-xml-parser";
import { torznabEndpoint } from "./torznab.js";

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", processEntities: false });
const idPattern = /^[a-z\d][a-z\d._-]{0,99}$/i;

export function jackettEndpoint(base, indexerId = "all") {
  if (!idPattern.test(indexerId)) throw new Error("Invalid Jackett indexer ID.");
  let url;
  try { url = new URL(String(base || "")); } catch { throw new Error("Enter a valid Jackett URL."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Use a Jackett HTTP(S) URL without credentials or query parameters.");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/api/v2.0/indexers/${indexerId}/results/torznab/api`;
  return torznabEndpoint(url.toString());
}

export function configuredJackett(environment = process.env) {
  const url = String(environment.JACKETT_URL || "").trim();
  const apiKey = String(environment.JACKETT_API_KEY || "").trim();
  if (!url || !apiKey || apiKey === "replace-me") throw new Error("Configure Jackett URL and API key in Services.");
  return { url, apiKey };
}

export function jackettProvider(provider, environment = process.env) {
  const service = configuredJackett(environment);
  return { ...provider, endpoint: jackettEndpoint(service.url, provider.indexerId), apiKey: service.apiKey };
}

export async function listJackettIndexers({ environment = process.env, fetchImpl = fetch, signal } = {}) {
  const service = configuredJackett(environment);
  const url = new URL(jackettEndpoint(service.url));
  url.searchParams.set("apikey", service.apiKey);
  url.searchParams.set("t", "indexers");
  url.searchParams.set("configured", "true");
  const response = await fetchImpl(url, {
    headers: { Accept: "application/xml, text/xml" }, cache: "no-store", redirect: "error",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw Object.assign(new Error("Jackett rejected the connection or API key."), { status: response.status });
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Jackett returned no indexer list.");
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 2_000_000) throw new Error("Jackett's indexer list is too large.");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const xml = Buffer.concat(chunks).toString("utf8");
  if (XMLValidator.validate(xml) !== true) throw new Error("Jackett returned an invalid indexer list.");
  const data = parser.parse(xml);
  if (!Object.hasOwn(data, "indexers") || data.error) throw new Error("Jackett returned an invalid indexer list.");
  const listed = data.indexers?.indexer;
  const items = listed == null ? [] : Array.isArray(listed) ? listed : [listed];
  return items.filter((item) => idPattern.test(String(item.id || ""))).map((item) => ({
    id: String(item.id), name: String(item.title || item.name || item.id).slice(0, 100),
  }));
}
