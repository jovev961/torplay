import { mapDebridEpisodeFile } from "../../../../../../../lib/debrid/library.js";
import { assertSettingsMutationRequest } from "../../../../../../../lib/settings/security.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request, context) {
  try {
    assertSettingsMutationRequest(request);
    const { provider, id } = await context.params;
    const body = await request.json();
    return Response.json(await mapDebridEpisodeFile(provider, id, body.fileId,
      body.season, body.episode));
  } catch (error) {
    return Response.json({ error: error.message }, { status: error.status || 422 });
  }
}
