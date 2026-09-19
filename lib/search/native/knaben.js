import { apiUrl, requestJson } from "./http.js";

export async function searchKnaben(context, { signal } = {}) {
  const queries = context.type === "show"
    ? [`${context.title} S${String(context.season).padStart(2, "0")}E${String(context.episode).padStart(2, "0")}`,
      `${context.title} S${String(context.season).padStart(2, "0")}`]
    : [context.title];
  const settled = await Promise.allSettled(queries.map(async (query) => {
    const data = await requestJson(apiUrl("KNABEN_API_URL", "https://api.knaben.org/v1"), {
      signal, body: { search_field: "title", search_type: "100%", query,
        order_by: "seeders", order_direction: "desc", size: 150, from: 0,
        hide_unsafe: true, hide_xxx: true },
    });
    if (!Array.isArray(data?.hits)) throw new Error("Invalid Knaben response.");
    return data.hits.filter((item) => item && typeof item === "object").map((item) => ({
      title: item.title, size: item.bytes, seeders: item.seeders,
      infoHash: item.hash, indexer: item.tracker || "Knaben",
      source: { magnet: item.magnetUrl, downloadUrl: item.link },
    }));
  }));
  if (settled.every((item) => item.status === "rejected")) throw new Error("Knaben search failed.");
  return settled.filter((item) => item.status === "fulfilled").flatMap((item) => item.value);
}

export const knabenProvider = { id: "knaben", name: "Knaben", search: searchKnaben };
