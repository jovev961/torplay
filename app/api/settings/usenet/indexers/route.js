import { assertSettingsMutationRequest } from "../../../../../lib/settings/security.js";
import { publicUsenetConfig, updateUsenetConfig, validateIndexer } from "../../../../../lib/usenet/config.js";
import { testNewznab } from "../../../../../lib/usenet/newznab.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request) {
  try {
    assertSettingsMutationRequest(request);
    const indexer = validateIndexer(await request.json());
    await testNewznab(indexer);
    const result = await updateUsenetConfig((current) => ({
      ...current, indexers: [...current.indexers, indexer],
    }));
    return Response.json(publicUsenetConfig(result), { status: 201 });
  } catch (error) {
    return Response.json({ error: error.message }, { status: error.status || 422 });
  }
}
