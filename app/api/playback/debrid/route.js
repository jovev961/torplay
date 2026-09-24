import { resolveDirectDebridPlayback } from "../../../../lib/debrid/library.js";
import { assertSettingsMutationRequest } from "../../../../lib/settings/security.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request) {
  try {
    assertSettingsMutationRequest(request);
    const result = await resolveDirectDebridPlayback(await request.json());
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error.message || "Could not check debrid playback." },
      { status: error.status || 502 });
  }
}
