import { stopTorrent } from "../../../../../lib/torrent/manager.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_request, context) {
  const { id } = await context.params;
  await stopTorrent(id);
  return new Response(null, { status: 204 });
}
