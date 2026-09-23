import { assertSettingsMutationRequest, assertSameOriginSettingsRequest } from "../../../../lib/settings/security.js";
import {
  changeCustomProvider,
  changeJackettProvider,
  availableJackettIndexers,
  jackettIndexerCapabilities,
  createCardigannProvider,
  customProviderHealth,
  removeCardigannProvider,
  testCardigannProviderConnection,
  testCustomProvider,
  updateCardigannProvider,
} from "../../../../lib/settings/torrent-providers.js";
import { importDefinition } from "../../../../lib/search/cardigann/definition.js";
import { communityDirectory } from "../../../../lib/search/community-directory.js";
import { changeNativeSource, nativeSourceHealth } from "../../../../lib/settings/native-sources.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const json = (data, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(request) {
  try {
    assertSameOriginSettingsRequest(request);
    let body;
    try { body = await request.json(); } catch { return json({ error: "Request body must be valid JSON." }, 400); }
    if (body?.action === "health") {
      const [native, custom] = await Promise.all([
        nativeSourceHealth({ refresh: body.refresh === true }),
        customProviderHealth({ refresh: body.refresh === true }),
      ]);
      return json({ results: [...native, ...custom] });
    }
    assertSettingsMutationRequest(request);
    if (["add-native", "update-native", "remove-native"].includes(body?.action)) {
      const action = body.action.replace("-native", "");
      return json({ nativeSources: await changeNativeSource(action, body.provider || {}) });
    }
    if (body?.action === "list-community-definitions") return json(await communityDirectory.list({ refresh: body.refresh === true }));
    if (body?.action === "import-community-definition") return json(await communityDirectory.importEntry(body.provider));
    if (body?.action === "import-definition") return json(await importDefinition(body.definitionUrl));
    if (body?.action === "create-cardigann") return json({ providers: await createCardigannProvider(body.provider || {}) });
    if (body?.action === "update-cardigann") return json({ providers: await updateCardigannProvider(body.provider || {}) });
    if (body?.action === "test-cardigann") return json(await testCardigannProviderConnection(body.provider || {}));
    if (body?.action === "remove-cardigann") return json({ providers: await removeCardigannProvider(body.provider || {}) });
    if (body?.action === "test") return json({ capabilities: await testCustomProvider(body.provider || {}) });
    if (body?.action === "jackett-indexers") return json({ indexers: await availableJackettIndexers() });
    if (body?.action === "jackett-capabilities") return json({ capabilities: await jackettIndexerCapabilities(body.provider?.indexerId) });
    if (["create-jackett", "update-jackett"].includes(body?.action)) return json({ providers: await changeJackettProvider(body.action.replace("-jackett", ""), body.provider || {}) });
    if (!["create", "update", "remove"].includes(body?.action)) return json({ error: "Unknown provider action." }, 400);
    return json({ providers: await changeCustomProvider(body.action, body.provider || {}) });
  } catch (error) {
    return json({
      error: error.status ? error.message : "Provider settings could not be processed.",
      ...(error.code ? { code: error.code } : {}),
      ...(error.unsupportedFeatures ? { unsupportedFeatures: error.unsupportedFeatures } : {}),
      ...(error.verificationFailure ? { verificationFailure: error.verificationFailure } : {}),
      ...(error.canAddUnverified ? { canAddUnverified: true, confirmationToken: error.confirmationToken } : {}),
    }, error.status || 400);
  }
}
