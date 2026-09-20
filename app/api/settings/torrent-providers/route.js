import { assertSettingsMutationRequest, assertSameOriginSettingsRequest } from "../../../../lib/settings/security.js";
import { changeCustomProvider, customProviderHealth, testCustomProvider } from "../../../../lib/settings/torrent-providers.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const json = (data, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(request) {
  try {
    assertSameOriginSettingsRequest(request);
    let body;
    try { body = await request.json(); } catch { return json({ error: "Request body must be valid JSON." }, 400); }
    if (body?.action === "health") return json({ results: await customProviderHealth({ refresh: body.refresh === true }) });
    assertSettingsMutationRequest(request);
    if (body?.action === "test") return json({ capabilities: await testCustomProvider(body.provider || {}) });
    if (!["create", "update", "remove"].includes(body?.action)) return json({ error: "Unknown provider action." }, 400);
    return json({ providers: await changeCustomProvider(body.action, body.provider || {}) });
  } catch (error) {
    return json({ error: error.status ? error.message : "Provider settings could not be processed." }, error.status || 400);
  }
}
