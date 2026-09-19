import { updateSubtitlePreferences } from "../../../../../lib/profiles/service.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(request, context) {
  try {
    const { id } = await context.params;
    const profile = updateSubtitlePreferences(id, await request.json());
    return Response.json({ profile }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json(
      { error: error.message || "Could not save subtitle preferences." },
      { status: error.status || 400 },
    );
  }
}
