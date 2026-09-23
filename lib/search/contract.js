/**
 * @typedef {Object} SearchContext
 * @property {string} title
 * @property {"generic"|"movie"|"show"} type
 * @property {number|null} [tmdbId]
 * @property {string|null} [imdbId]
 * @property {number|null} [year]
 * @property {number|null} [season]
 * @property {number|null} [episode]
 * @property {string[]} [categories] Optional Cardigann/Newznab category paths.
 *
 * @typedef {Object} TorrentCandidate
 * @property {string} title
 * @property {string} providerId Assigned by the provider boundary.
 * @property {string} providerName Assigned by the provider boundary.
 * @property {string} indexer
 * @property {number} size
 * @property {number} seeders
 * @property {number|null} leechers
 * @property {string|null} infoHash
 * @property {string|null} quality
 * @property {string|null} resolution
 * @property {string|null} codec
 * @property {Object|null} media Provider-reported release metadata, not requested playback context.
 * @property {{magnet: string|null, downloadUrl: string|null}} source Server-only.
 *
 * @typedef {Object} TorrentProvider
 * @property {string} id Stable identifier.
 * @property {string} name Display name.
 * @property {function(SearchContext, {signal: AbortSignal}): Promise<TorrentCandidate[]>} search
 */

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function count(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

function hash(value) {
  const raw = text(value);
  if (/^[a-f\d]{40}$/i.test(raw || "")) return raw.toLowerCase();
  if (/^[a-z2-7]{32}$/i.test(raw || "")) return raw.toUpperCase();
  if (/^[a-f\d]{64}$/i.test(raw || "")) return raw.toLowerCase();
  return null;
}

function sourceUrl(value, protocols) {
  try {
    const url = new URL(value);
    return protocols.includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

export function normalizeCandidate(candidate, provider) {
  if (!candidate || typeof candidate !== "object") return null;
  const title = text(candidate.title);
  if (!title) return null;
  let infoHash = hash(candidate.infoHash);
  let magnet = sourceUrl(candidate.source?.magnet, ["magnet:"]);
  if (magnet) {
    const topics = new URL(magnet).searchParams.getAll("xt");
    const topic = topics.find((value) => /^urn:btih:/i.test(value));
    const magnetHash = hash(topic?.slice(9));
    if (!magnetHash || magnetHash.length === 64) magnet = null;
    else infoHash = magnetHash;
  }
  // The existing playback engine supports v1 hash-only sources.
  if (!magnet && infoHash && infoHash.length !== 64) {
    magnet = `magnet:?xt=urn:btih:${infoHash}`;
  }
  const downloadUrl = sourceUrl(candidate.source?.downloadUrl, ["http:", "https:"]);
  const resolver = typeof candidate.source?.resolver === "function" ? candidate.source.resolver : null;
  if (!magnet && !downloadUrl && !resolver) return null;
  const media = candidate.media && typeof candidate.media === "object" ? {
    type: ["movie", "show"].includes(candidate.media.type) ? candidate.media.type : null,
    tmdbId: count(candidate.media.tmdbId),
    imdbId: /^tt\d+$/.test(candidate.media.imdbId || "") ? candidate.media.imdbId : null,
    year: count(candidate.media.year),
    season: count(candidate.media.season),
    episode: count(candidate.media.episode),
  } : null;
  return {
    providerId: provider.id, providerName: provider.name,
    title, indexer: text(candidate.indexer) || provider.name,
    size: count(candidate.size, 0), seeders: count(candidate.seeders, 0),
    leechers: count(candidate.leechers), infoHash,
    quality: text(candidate.quality), resolution: text(candidate.resolution),
    codec: text(candidate.codec), media,
    source: { magnet, downloadUrl, resolver },
  };
}
