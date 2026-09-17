import { listContinueWatching } from "../../../../../lib/history/service.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request, context) {
  try {
    const { id } = await context.params;
    return Response.json(
      { items: listContinueWatching(id) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return Response.json({ error: error.message || "Continue Watching is unavailable." }, { status: error.status || 500 });
  }
}
