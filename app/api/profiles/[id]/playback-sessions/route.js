import { beginPlaybackSession } from "../../../../../lib/history/service.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request, context) {
  try {
    const { id } = await context.params;
    return Response.json(beginPlaybackSession(id, await request.json()), {
      status: 201,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return Response.json({ error: error.message || "Could not start progress tracking." }, { status: error.status || 400 });
  }
}
