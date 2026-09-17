import { getProgress, saveProgress } from "../../../../../lib/history/service.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function identity(params) {
  return {
    mediaType: params.get("mediaType"),
    tmdbId: params.get("tmdbId"),
    seasonNumber: params.get("seasonNumber"),
    episodeNumber: params.get("episodeNumber"),
  };
}

export async function GET(request, context) {
  try {
    const { id } = await context.params;
    return Response.json(
      { progress: getProgress(id, identity(new URL(request.url).searchParams)) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return Response.json({ error: error.message || "Progress is unavailable." }, { status: error.status || 400 });
  }
}

export async function PUT(request, context) {
  try {
    const { id } = await context.params;
    return Response.json(saveProgress(id, await request.json()), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error.message || "Could not save progress." }, { status: error.status || 400 });
  }
}
