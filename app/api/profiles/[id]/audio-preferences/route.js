import { updateAudioPreferences } from "../../../../../lib/profiles/service.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(request, context) {
  try {
    const { id } = await context.params;
    const profile = updateAudioPreferences(id, await request.json());
    return Response.json({ profile }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json(
      { error: error.message || "Could not save audio preferences." },
      { status: error.status || 400 },
    );
  }
}
