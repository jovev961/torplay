import { nativeApiUrl, requestNativeJson } from "./http.js";

const API_BASE = "https://eztvx.to/api/";

function endpoint(options) {
  return nativeApiUrl(options.baseUrl || API_BASE, "get-torrents");
}

function validResponse(data) {
  return Array.isArray(data?.torrents) || Number(data?.torrents_count) === 0;
}

export async function searchEztv(context, options = {}) {
  if (context.type !== "show" || !/^tt[0-9]+$/.test(context.imdbId || "")) return [];
  const results = [];
  for (let page = 1; page <= 10; page += 1) {
    options.signal?.throwIfAborted();
    const url = endpoint(options);
    url.searchParams.set("imdb_id", context.imdbId.slice(2));
    url.searchParams.set("limit", "100");
    url.searchParams.set("page", String(page));
    let data;
    try {
      data = await requestNativeJson(url, options);
      if (!validResponse(data)) throw new Error("Invalid EZTV response.");
    } catch (error) {
      if (options.signal?.aborted || page === 1) throw error;
      break;
    }
    const torrents = data.torrents || [];
    for (const item of torrents) {
      if (!item || String(item.imdb_id) !== context.imdbId.slice(2)) continue;
      if (Number(item.season) !== Number(context.season)) continue;
      if (Number(item.episode) !== Number(context.episode) && Number(item.episode) !== 0) continue;
      results.push({
        title: item.title || item.filename,
        size: item.size_bytes,
        seeders: item.seeds,
        leechers: item.peers,
        infoHash: item.hash,
        indexer: "EZTV",
        media: {
          type: "show",
          imdbId: context.imdbId,
          season: Number(item.season),
          episode: Number(item.episode) || null,
        },
        source: { magnet: item.magnet_url, downloadUrl: item.torrent_url },
      });
    }
    if (!torrents.length || torrents.length < 100 || page * 100 >= Number(data.torrents_count)) break;
  }
  return results;
}

export async function probeEztv(options = {}) {
  const url = endpoint(options);
  url.searchParams.set("imdb_id", "0096697");
  url.searchParams.set("limit", "1");
  url.searchParams.set("page", "1");
  if (!validResponse(await requestNativeJson(url, options))) throw new Error("Invalid EZTV response.");
}

export const eztvProvider = {
  id: "eztv",
  name: "EZTV",
  description: "TV episode torrent search using IMDb series identifiers.",
  mediaTypes: ["TV"],
  search: searchEztv,
  probe: probeEztv,
};
