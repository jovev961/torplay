import { apiUrl, requestJson } from "./http.js";

export async function searchYts(context, { signal } = {}) {
  if (context.type === "show") return [];
  const url = apiUrl("YTS_API_URL", "https://movies-api.accel.li/api/v2/", "list_movies.json");
  const imdbId = /^tt[0-9]+$/.test(context.imdbId || "") ? context.imdbId : null;
  url.searchParams.set("query_term", imdbId || context.title);
  url.searchParams.set("limit", "50");
  url.searchParams.set("sort_by", "seeds");
  const data = await requestJson(url, { signal });
  if (data?.status !== "ok" || !data.data || (!Array.isArray(data.data.movies) && data.data.movie_count !== 0)) {
    throw new Error("Invalid YTS response.");
  }
  return (data.data.movies || []).filter((movie) => movie && (!imdbId || movie.imdb_code === imdbId)
    && (!context.year || Number(movie.year) === Number(context.year))).flatMap((movie) => (
    Array.isArray(movie.torrents) ? movie.torrents.filter(Boolean).map((torrent) => ({
      title: `${movie.title} ${movie.year || ""} ${torrent.quality || ""} ${torrent.type || ""} ${torrent.video_codec || ""}`.trim(),
      size: torrent.size_bytes, seeders: torrent.seeds, leechers: torrent.peers,
      infoHash: torrent.hash, indexer: "YTS",
      quality: torrent.type, resolution: torrent.quality, codec: torrent.video_codec,
      media: { type: "movie", imdbId: movie.imdb_code, year: movie.year },
      source: { downloadUrl: torrent.url },
    })) : []
  ));
}

export const ytsProvider = {
  id: "yts",
  name: "YTS",
  description: "Movie-focused torrent search with multiple quality options.",
  mediaTypes: ["Movies"],
  search: searchYts,
};
