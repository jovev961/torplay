import { XMLParser, XMLValidator } from "fast-xml-parser";
import { openRemoteUrl } from "../debrid/stream.js";

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", processEntities: false });
const asArray = (value) => value == null ? [] : Array.isArray(value) ? value : [value];
const text = (value) => typeof value === "string" || typeof value === "number" ? String(value) : "";

export async function readLimited(response, limit = 2_000_000) {
  if (response.statusCode !== 200) {
    response.destroy();
    throw new Error(response.statusCode === 401 || response.statusCode === 403
      ? "Indexer authentication failed." : "Indexer unavailable.");
  }
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of response) {
      size += chunk.length;
      if (size > limit) throw new Error("Indexer response is too large.");
      chunks.push(chunk);
    }
  } finally { response.destroy(); }
  return Buffer.concat(chunks);
}

export function parseXml(buffer) {
  const xml = buffer.toString("utf8");
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) {
    throw new Error("Indexer returned invalid XML.");
  }
  return parser.parse(xml);
}

export function validateNzb(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > 2_000_000) {
    throw Object.assign(new Error("NZB must be between 1 byte and 2 MB."), { status: 400 });
  }
  const xml = buffer.toString("utf8");
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true
    || !parser.parse(xml)?.nzb) {
    throw Object.assign(new Error("Invalid NZB file."), { status: 400 });
  }
  return buffer;
}

function indexerUrl(indexer, parameters = {}) {
  const url = new URL(indexer.endpoint);
  url.searchParams.set("apikey", indexer.apiKey);
  for (const [key, value] of Object.entries(parameters)) {
    if (value !== null && value !== undefined && value !== "") url.searchParams.set(key, value);
  }
  return url;
}

export async function indexerRequest(indexer, parameters, options = {}) {
  const url = indexerUrl(indexer, parameters);
  const response = await openRemoteUrl(url.href, {
    allowRedirects: false, signal: AbortSignal.timeout(options.timeoutMs || 12_000),
    ...(options.transport || {}),
  });
  return readLimited(response);
}

export async function testNewznab(indexer, options = {}) {
  const data = parseXml(await indexerRequest(indexer, { t: "caps" }, options));
  if (!data.caps?.searching) throw new Error("Indexer returned invalid capabilities.");
  return true;
}

export function parseNewznabResults(buffer, indexer) {
  const feed = parseXml(buffer);
  if (feed.error) throw new Error("Indexer rejected the search.");
  if (!feed.rss?.channel) throw new Error("Indexer returned an invalid feed.");
  return asArray(feed.rss.channel.item).flatMap((item) => {
    const title = text(item.title).trim().replace(/[\u0000-\u001f]/g, " ").slice(0, 300);
    const raw = text(item.enclosure?.url || item.link);
    let url;
    try { url = new URL(raw); } catch { return []; }
    if (!title || url.origin !== new URL(indexer.endpoint).origin
      || url.username || url.password || url.protocol !== "https:") return [];
    const attrs = Object.fromEntries(asArray(item["newznab:attr"])
      .filter((attribute) => attribute?.name).map((attribute) => [attribute.name, attribute.value]));
    const size = Number(item.enclosure?.length || attrs.size || 0);
    return [{
      kind: "nzb", title, nzbUrl: url.href, guid: text(item.guid) || null,
      size: Number.isSafeInteger(size) && size > 0 ? size : null,
      publishedAt: text(item.pubDate) || null, category: text(attrs.category) || null,
      indexerId: indexer.id, indexer: indexer.name,
    }];
  });
}

export async function searchNewznab(indexer, context, options = {}) {
  const season = context.type === "show" ? context.season : null;
  const episode = context.type === "show" ? context.episode : null;
  const mode = context.type === "show" ? "tvsearch" : context.type === "movie" ? "movie" : "search";
  const parameters = { t: mode, q: context.title, season, ep: episode, limit: 50 };
  try {
    return parseNewznabResults(await indexerRequest(indexer, parameters, options), indexer);
  } catch (error) {
    if (mode === "search") throw error;
    const q = `${context.title}${season == null ? "" : ` S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`}`;
    return parseNewznabResults(await indexerRequest(indexer, { t: "search", q, limit: 50 }, options), indexer);
  }
}

export async function fetchNzb(indexer, rawUrl, options = {}) {
  let url;
  try { url = new URL(rawUrl); } catch { throw new Error("NZB URL is invalid."); }
  if (url.origin !== new URL(indexer.endpoint).origin || url.username || url.password) {
    throw new Error("NZB URL is outside the configured indexer.");
  }
  url.searchParams.set("apikey", indexer.apiKey);
  const response = await openRemoteUrl(url.href, {
    allowRedirects: false, signal: AbortSignal.timeout(options.timeoutMs || 15_000),
    ...(options.transport || {}),
  });
  return validateNzb(await readLimited(response));
}
