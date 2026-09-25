import { getEpisodeSegments } from "../../../../lib/playback/segments.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  const params = new URL(request.url).searchParams;
  const tmdbId = Number(params.get("tmdbId"));
  const season = Number(params.get("season"));
  const episode = Number(params.get("episode"));
  const duration = Number(params.get("duration"));
  if (!Number.isSafeInteger(tmdbId) || tmdbId <= 0
    || !Number.isSafeInteger(season) || season < 0
    || !Number.isSafeInteger(episode) || episode <= 0
    || !Number.isFinite(duration) || duration < 1 || duration > 24 * 60 * 60) {
    return Response.json({ error: "Episode and duration are invalid." }, { status: 400 });
  }
  const result = await getEpisodeSegments({ tmdbId, season, episode, duration });
  return Response.json(result, { headers: { "Cache-Control": "no-store" } });
}
