import { playDebridItem } from "../../../../../../../lib/debrid/library.js";
import { assertSettingsMutationRequest } from "../../../../../../../lib/settings/security.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request, context) {
  try {
    assertSettingsMutationRequest(request);
    const { provider, id } = await context.params;
    const body = await request.json();
    return Response.json(await playDebridItem(provider, id, body.fileId,
      body.scope ? { selectionScope: body.scope } : {}), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return Response.json({
      code: error.code || "DEBRID_PLAYBACK_FAILED",
      error: error.message,
    }, { status: error.status || 422 });
  }
}
