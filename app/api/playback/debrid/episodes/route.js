import { listReadyDebridEpisodes } from "../../../../../lib/debrid/library.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const tmdbId = new URL(request.url).searchParams.get("tmdbId");
    const result = await listReadyDebridEpisodes(tmdbId);
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error.message || "Could not load ready episodes." },
      { status: error.status || 502 });
  }
}
