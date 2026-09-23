import {
  SettingsError,
  updateProviderSettings,
} from "../../../lib/settings/config.js";
import {
  assertSettingsMutationRequest,
  isLocalNetworkSettingsRequest,
} from "../../../lib/settings/security.js";
import { getSettingsSnapshot } from "../../_lib/settings-snapshot.js";
import { clearSettingsValidation } from "../../../lib/settings/validation.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(error) {
  return Response.json(
    { error: error.message || "Settings could not be updated." },
    {
      status: Number.isInteger(error.status) ? error.status : 500,
      headers: { "Cache-Control": "no-store" },
    },
  );
}

export async function GET(request) {
  try {
    const snapshot = await getSettingsSnapshot({ canEdit: isLocalNetworkSettingsRequest(request) });
    return Response.json(snapshot, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json(
      { error: "Settings status could not be loaded." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export async function PATCH(request) {
  try {
    assertSettingsMutationRequest(request);
    let body;
    try {
      body = await request.json();
    } catch {
      throw new SettingsError("Request body must be valid JSON.");
    }
    if (!body || typeof body.provider !== "string") {
      throw new SettingsError("A settings provider is required.");
    }
    await updateProviderSettings(body.provider, body);
    clearSettingsValidation(body.provider);
    const snapshot = await getSettingsSnapshot({ canEdit: true });
    return Response.json(snapshot, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
