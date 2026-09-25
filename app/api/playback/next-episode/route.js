import {
  commitNextEpisodeContext,
  resolveNextEpisodePlayback,
} from "../../../../lib/playback/next-episode.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request) {
  try {
    const body = await request.json();
    if (typeof body?.sessionId !== "string" || !body.sessionId) {
      return Response.json({ error: "Torrent session ID is required." }, { status: 400 });
    }
    const result = body.action === "advance"
      ? { mediaContext: commitNextEpisodeContext(body.sessionId, body) }
      : await resolveNextEpisodePlayback(body.sessionId, {}, body.direction || "next", body.target);
    return Response.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return Response.json({ error: error.message || "Could not resolve the next episode." }, { status: error.status || 502 });
  }
}
