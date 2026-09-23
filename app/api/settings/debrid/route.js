import { readDebridConfig, updateDebridPolicy, publicDebridConfig } from "../../../../lib/debrid/config.js";
import { assertSettingsMutationRequest, isLocalNetworkSettingsRequest } from "../../../../lib/settings/security.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  const config = await readDebridConfig();
  return Response.json({ ...publicDebridConfig(config), canEdit: isLocalNetworkSettingsRequest(request) }, {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function PATCH(request) {
  try {
    assertSettingsMutationRequest(request);
    const config = await updateDebridPolicy(await request.json());
    return Response.json(publicDebridConfig(config), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error.message || "Debrid settings could not be saved." }, {
      status: Number.isInteger(error.status) ? error.status : 500,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
