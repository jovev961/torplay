import { getSearchResult } from "../../../lib/search/result-store.js";
import { startPlaybackSource } from "../../../lib/debrid/session.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const source = getSearchResult(body?.resultId);
  if (!source) {
    return Response.json(
      { error: "That search result expired or is invalid. Search again." },
      { status: 404 },
    );
  }

  try {
    const session = await startPlaybackSource(source);
    return Response.json(session, {
      status: session.status === "loading" ? 202 : 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return Response.json({
      code: error.code || "PLAYBACK_START_FAILED",
      error: error.message || "Could not start playback.",
    }, { status: Number.isInteger(error.status) ? error.status : 422 });
  }
}
