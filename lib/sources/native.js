import { request, endpointUrl } from "../network/request.js";
import { SourceError } from "./contract.js";

export const testedSources = [
  { id: "yts", name: "YTS", description: "Movie torrent search.", mediaTypes: ["Movies"] },
  { id: "eztv", name: "EZTV", description: "TV episode torrent search.", mediaTypes: ["TV"] },
  { id: "knaben", name: "Knaben", description: "Movie and TV torrent search.", mediaTypes: ["Movies", "TV"] },
];

async function json(url, options, body) {
  const response = await (options.request || request)(endpointUrl(url), { signal: options.signal,
    headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    method: body ? "POST" : "GET", body: body ? JSON.stringify(body) : undefined,
    timeoutMs: 15_000, maxBytes: 5 * 1024 * 1024 });
  if (response.status !== 200) throw new SourceError("SOURCE_UNAVAILABLE", "The native source could not be reached.", 502);
  try { return JSON.parse(response.body.toString("utf8")); }
  catch { throw new SourceError("INVALID_RESPONSE", "The native source returned invalid JSON."); }
}

async function yts(context, options) {
  if (context.type === "show") return [];
  const url = new URL("https://movies-api.accel.li/api/v2/list_movies.json");
  url.searchParams.set("query_term", context.imdbId || context.title);
  url.searchParams.set("limit", options.probe ? "1" : "50");
  url.searchParams.set("sort_by", "seeds");
  const data = await json(url, options);
  if (data?.status !== "ok" || !data.data || (!Array.isArray(data.data.movies) && Number(data.data.movie_count) !== 0)) {
    throw new SourceError("INVALID_RESPONSE", "The native source returned an invalid movie response.");
  }
  return (data.data.movies || []).flatMap((movie) => (Array.isArray(movie?.torrents) ? movie.torrents : []).filter(Boolean).map((torrent) => ({
    title: [movie.title, movie.year, torrent.quality, torrent.type, torrent.video_codec].filter(Boolean).join(" "),
    infoHash: torrent.hash, size: torrent.size_bytes, seeders: torrent.seeds, leechers: torrent.peers,
    quality: torrent.type, resolution: torrent.quality, codec: torrent.video_codec,
    media: { type: "movie", imdbId: movie.imdb_code, year: movie.year }, locator: { downloadUrl: torrent.url },
  })));
}

async function eztv(context, options) {
  if (context.type !== "show" || !context.imdbId) return [];
  const candidates = [];
  for (let page = 1; page <= (options.probe ? 1 : 10); page++) {
    options.signal?.throwIfAborted();
    const url = new URL("https://eztvx.to/api/get-torrents");
    for (const [key, value] of Object.entries({ imdb_id: context.imdbId.slice(2), limit: options.probe ? 1 : 100, page })) url.searchParams.set(key, String(value));
    const data = await json(url, options);
    if (!Array.isArray(data?.torrents) && Number(data?.torrents_count) !== 0) throw new SourceError("INVALID_RESPONSE", "The native source returned an invalid episode response.");
    for (const torrent of data.torrents || []) if (torrent) candidates.push({
      title: torrent.title || torrent.filename, infoHash: torrent.hash, size: torrent.size_bytes,
      seeders: torrent.seeds, leechers: torrent.peers,
      media: { type: "show", imdbId: /^\d+$/.test(String(torrent.imdb_id)) ? `tt${torrent.imdb_id}` : null,
        season: torrent.season, episode: Number(torrent.episode) || null },
      locator: { magnet: torrent.magnet_url, downloadUrl: torrent.torrent_url },
    });
    if ((data.torrents || []).length < 100 || page * 100 >= Number(data.torrents_count)) break;
  }
  return candidates;
}

async function knaben(context, options) {
  const queries = context.type === "show" ? [
    `${context.title} S${String(context.season).padStart(2, "0")}E${String(context.episode).padStart(2, "0")}`,
    `${context.title} S${String(context.season).padStart(2, "0")}`,
  ] : [`${context.title}${context.year ? ` ${context.year}` : ""}`];
  const settled = await Promise.allSettled(queries.map(async (query) => {
    const data = await json("https://api.knaben.org/v1", options, {
      search_field: "title", search_type: "100%", query, order_by: "seeders", order_direction: "desc",
      size: options.probe ? 1 : 150, from: 0, hide_unsafe: true, hide_xxx: true,
    });
    if (!Array.isArray(data?.hits)) throw new SourceError("INVALID_RESPONSE", "The native source returned invalid search results.");
    return data.hits.filter(Boolean).map((hit) => ({ title: hit.title, size: hit.bytes,
      seeders: hit.seeders, leechers: hit.peers, infoHash: hit.hash, origin: hit.tracker,
      locator: { magnet: hit.magnetUrl, downloadUrl: hit.link } }));
  }));
  options.signal?.throwIfAborted();
  if (settled.every((item) => item.status === "rejected")) throw settled[0].reason;
  return settled.filter((item) => item.status === "fulfilled").flatMap((item) => item.value);
}

export function searchNative(source, context, options = {}) {
  const search = { yts, eztv, knaben }[source.id];
  if (!search) throw new SourceError("CONFIGURATION_REQUIRED", "Unknown native source.");
  return search(context, options);
}

export function verifyNative(source, options = {}) {
  return searchNative(source, { title: source.id === "eztv" ? "The Simpsons" : "Sintel", type: source.id === "eztv" ? "show" : "movie",
    imdbId: source.id === "eztv" ? "tt0096697" : "tt1727587", season: 1, episode: 1 }, { ...options, probe: true }).then(() => true);
}
