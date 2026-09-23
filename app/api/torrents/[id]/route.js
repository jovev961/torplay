import { getPlaybackSession, stopPlayback } from "../../../../lib/debrid/session.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request, context) {
  const { id } = await context.params;
  const session = getPlaybackSession(id);
  if (!session) {
    return Response.json({ error: "Torrent session not found." }, { status: 404 });
  }
  return Response.json(session, { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(_request, context) {
  const { id } = await context.params;
  await stopPlayback(id);
  return new Response(null, { status: 204 });
}
