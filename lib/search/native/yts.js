import { nativeApiUrl, requestNativeJson } from "./http.js";

const API_BASE = "https://movies-api.accel.li/api/v2/";

function endpoint(options) {
  return nativeApiUrl(options.baseUrl || API_BASE, "list_movies.json");
}

export async function searchYts(context, options = {}) {
  if (context.type === "show") return [];
  const url = endpoint(options);
  const imdbId = /^tt[0-9]+$/.test(context.imdbId || "") ? context.imdbId : null;
  url.searchParams.set("query_term", imdbId || context.title);
  url.searchParams.set("limit", "50");
  url.searchParams.set("sort_by", "seeds");
  const data = await requestNativeJson(url, options);
  if (data.status !== "ok" || !data.data
    || (!Array.isArray(data.data.movies) && Number(data.data.movie_count) !== 0)) {
    throw new Error("Invalid YTS response.");
  }
  return (data.data.movies || []).filter((movie) => movie
    && (!imdbId || movie.imdb_code === imdbId)
    && (!context.year || Number(movie.year) === Number(context.year))).flatMap((movie) => (
    Array.isArray(movie.torrents) ? movie.torrents.filter(Boolean).map((torrent) => ({
      title: `${movie.title} ${movie.year || ""} ${torrent.quality || ""} ${torrent.type || ""} ${torrent.video_codec || ""}`.trim(),
      size: torrent.size_bytes,
      seeders: torrent.seeds,
      leechers: torrent.peers,
      infoHash: torrent.hash,
      indexer: "YTS",
      quality: torrent.type,
      resolution: torrent.quality,
      codec: torrent.video_codec,
      media: { type: "movie", imdbId: movie.imdb_code, year: movie.year },
      source: { downloadUrl: torrent.url },
    })) : []
  ));
}

export async function probeYts(options = {}) {
  const url = endpoint(options);
  url.searchParams.set("query_term", "tt1727587");
  url.searchParams.set("limit", "1");
  const data = await requestNativeJson(url, options);
  if (data.status !== "ok" || !data.data
    || (!Array.isArray(data.data.movies) && Number(data.data.movie_count) !== 0)) {
    throw new Error("Invalid YTS response.");
  }
}

export const ytsProvider = {
  id: "yts",
  name: "YTS",
  description: "Movie-focused torrent search with multiple quality options.",
  mediaTypes: ["Movies"],
  search: searchYts,
  probe: probeYts,
};
