import { SettingsError, updatePlaybackPreferences } from "../../../../lib/settings/config.js";
import { assertSettingsMutationRequest } from "../../../../lib/settings/security.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(request) {
  try {
    assertSettingsMutationRequest(request);
    const preferences = await updatePlaybackPreferences(await request.json());
    return Response.json({ preferences }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error.message || "Playback settings could not be saved." },
      { status: error instanceof SettingsError ? error.status : error.status || 400 });
  }
}
