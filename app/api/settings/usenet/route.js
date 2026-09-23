import { readDebridConfig } from "../../../../lib/debrid/config.js";
import { isLocalNetworkSettingsRequest, assertSettingsMutationRequest } from "../../../../lib/settings/security.js";
import { publicUsenetConfig, readUsenetConfig, updateUsenetConfig } from "../../../../lib/usenet/config.js";
import { TorBoxUsenet } from "../../../../lib/usenet/torbox.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  const [config, debrid] = await Promise.all([readUsenetConfig(), readDebridConfig()]);
  const key = debrid.credentials.torbox?.apiKey;
  const capability = key ? await new TorBoxUsenet(key).capability() : "not-configured";
  return Response.json({ ...publicUsenetConfig(config), capability,
    canEdit: isLocalNetworkSettingsRequest(request) }, { headers: { "Cache-Control": "no-store" } });
}

export async function PATCH(request) {
  try {
    assertSettingsMutationRequest(request);
    const body = await request.json();
    if (typeof body?.enabled !== "boolean") return Response.json({ error: "Invalid Usenet setting." }, { status: 400 });
    const result = await updateUsenetConfig((current) => ({ ...current, enabled: body.enabled }));
    return Response.json(publicUsenetConfig(result));
  } catch (error) {
    return Response.json({ error: error.message }, { status: error.status || 500 });
  }
}
