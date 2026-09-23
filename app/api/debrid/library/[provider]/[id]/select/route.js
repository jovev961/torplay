import { confirmRealDebridFiles } from "../../../../../../../lib/debrid/library.js";
import { assertSettingsMutationRequest } from "../../../../../../../lib/settings/security.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request, context) {
  try {
    assertSettingsMutationRequest(request);
    const { provider, id } = await context.params;
    if (provider !== "real-debrid") return Response.json({ error: "Only Real-Debrid uses file selection." }, { status: 422 });
    const body = await request.json();
    return Response.json(await confirmRealDebridFiles(id, body.fileIds, body.episodeFileId));
  } catch (error) {
    return Response.json({ error: error.message }, { status: error.status || 422 });
  }
}
