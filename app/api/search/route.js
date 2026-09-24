import { findAuthorizedSources } from "../../../lib/search/service.js";
import { findUsenetSources } from "../../../lib/usenet/search.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function optionalInteger(value, label, { allowZero = false } = {}) {
  if (value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
    throw Object.assign(new Error(`${label} must be a valid integer.`), { status: 400 });
  }
  return parsed;
}

export async function GET(request) {
  try {
    const params = new URL(request.url).searchParams;
    const query = params.get("q");
    const options = {
      type: params.get("type") || "generic",
      season: params.get("season"),
      episode: params.get("episode"),
    };
    const mediaContext = {
      type: options.type,
      tmdbId: optionalInteger(params.get("tmdbId"), "TMDB ID"),
      imdbId: params.get("imdbId") || null,
      title: query,
      originalTitle: options.type === "movie" ? params.get("originalTitle") : null,
      year: optionalInteger(params.get("year"), "Year", { allowZero: true }),
      season: options.type === "show" ? optionalInteger(options.season, "Season", { allowZero: true }) : null,
      episode: options.type === "show" ? optionalInteger(options.episode, "Episode") : null,
    };
    const [torrents, usenet] = await Promise.allSettled([
      findAuthorizedSources(mediaContext), findUsenetSources(mediaContext),
    ]);
    if (torrents.status === "rejected" && usenet.status === "rejected") throw torrents.reason;
    const results = torrents.status === "fulfilled" ? torrents.value : [];
    const usenetResults = usenet.status === "fulfilled" ? usenet.value : [];
    if (!results.length && !usenetResults.length && torrents.status === "rejected") throw torrents.reason;
    return Response.json({ results, usenetResults }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error.message || "Search failed.";
    const status = Number.isInteger(error.status) ? error.status : 502;
    return Response.json({ error: message, ...(error.code ? { code: error.code } : {}) }, { status });
  }
}
