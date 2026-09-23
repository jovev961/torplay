import { readUsenetConfig, publicUsenetConfig, updateUsenetConfig } from "../../../../../../lib/usenet/config.js";
import { assertSettingsMutationRequest } from "../../../../../../lib/settings/security.js";
import { testNewznab } from "../../../../../../lib/usenet/newznab.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request, context) {
  try {
    assertSettingsMutationRequest(request);
    const { id } = await context.params;
    const config = await readUsenetConfig();
    const indexer = config.indexers.find((item) => item.id === id);
    if (!indexer) return Response.json({ error: "Indexer not found." }, { status: 404 });
    await testNewznab(indexer);
    return Response.json({ status: "connected" });
  } catch (error) {
    return Response.json({ error: error.message }, { status: error.status || 422 });
  }
}

export async function DELETE(request, context) {
  try {
    assertSettingsMutationRequest(request);
    const { id } = await context.params;
    const config = await updateUsenetConfig((current) => ({
      ...current, indexers: current.indexers.filter((item) => item.id !== id),
    }));
    return Response.json(publicUsenetConfig(config));
  } catch (error) {
    return Response.json({ error: error.message }, { status: error.status || 500 });
  }
}
