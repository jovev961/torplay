import { nativeApiUrl, requestNativeJson } from "./http.js";

const API_URL = "https://api.knaben.org/v1";

function queryUrl(options) {
  return nativeApiUrl(options.baseUrl || API_URL);
}

async function searchQuery(query, options) {
  const data = await requestNativeJson(queryUrl(options), {
    ...options,
    body: {
      search_field: "title",
      search_type: "100%",
      query,
      order_by: "seeders",
      order_direction: "desc",
      size: options.size ?? 150,
      from: 0,
      hide_unsafe: true,
      hide_xxx: true,
    },
  });
  if (!Array.isArray(data.hits)) throw new Error("Invalid Knaben response.");
  return data.hits.filter((item) => item && typeof item === "object").map((item) => ({
    title: item.title,
    size: item.bytes,
    seeders: item.seeders,
    leechers: item.peers,
    infoHash: item.hash,
    indexer: item.tracker || "Knaben",
    source: { magnet: item.magnetUrl, downloadUrl: item.link },
  }));
}

export async function searchKnaben(context, options = {}) {
  const queries = context.type === "show"
    ? [
        `${context.title} S${String(context.season).padStart(2, "0")}E${String(context.episode).padStart(2, "0")}`,
        `${context.title} S${String(context.season).padStart(2, "0")}`,
      ]
    : [`${context.title}${context.year ? ` ${context.year}` : ""}`];
  const settled = await Promise.allSettled(queries.map((query) => searchQuery(query, options)));
  if (settled.every((item) => item.status === "rejected")) throw new Error("Knaben search failed.");
  return settled.filter((item) => item.status === "fulfilled").flatMap((item) => item.value);
}

export async function probeKnaben(options = {}) {
  await searchQuery("Sintel", { ...options, size: 1 });
}

export const knabenProvider = {
  id: "knaben",
  name: "Knaben",
  description: "General torrent search for movies and TV episodes.",
  mediaTypes: ["Movies", "TV"],
  search: searchKnaben,
  probe: probeKnaben,
};
