import { XMLParser, XMLValidator } from "fast-xml-parser";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  processEntities: false,
  trimValues: true,
});

export class TorznabXmlError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "TorznabXmlError";
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

export function parseTorznabXml(xml) {
  if (XMLValidator.validate(xml) !== true) {
    throw new TorznabXmlError("Provider returned invalid XML.", 502);
  }

  let document;
  try {
    document = parser.parse(xml);
  } catch {
    throw new TorznabXmlError("Provider returned invalid XML.", 502);
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
