import {
  listHistory,
  removeHistory,
  removeTitleHistory,
} from "../../../../../lib/history/service.js";

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

export async function GET(_request, context) {
  try {
    const { id } = await context.params;
    return Response.json({ history: listHistory(id) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error.message || "History is unavailable." }, { status: error.status || 500 });
  }
}

export async function DELETE(request, context) {
  try {
    const { id } = await context.params;
    const params = new URL(request.url).searchParams;
    if (params.get("scope") === "title") {
      removeTitleHistory(id, identity(params));
    } else {
      removeHistory(id, identity(params));
    }
    return new Response(null, { status: 204 });
  } catch (error) {
    return Response.json({ error: error.message || "Could not remove history." }, { status: error.status || 400 });
  }
}
