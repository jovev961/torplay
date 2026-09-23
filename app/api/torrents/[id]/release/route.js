import { stopPlayback } from "../../../../../lib/debrid/session.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_request, context) {
  const { id } = await context.params;
  await stopPlayback(id);
  return new Response(null, { status: 204 });
}
