import { getTorrentSession, stopTorrent } from "../../../../lib/torrent/manager.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request, context) {
  const { id } = await context.params;
  const session = getTorrentSession(id);
  if (!session) {
    return Response.json({ error: "Torrent session not found." }, { status: 404 });
  }
  return Response.json(session, { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(_request, context) {
  const { id } = await context.params;
  await stopTorrent(id);
  return new Response(null, { status: 204 });
}
