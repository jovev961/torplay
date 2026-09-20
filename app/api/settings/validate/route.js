import { SettingsError } from "../../../../lib/settings/config.js";
import { assertSameOriginSettingsRequest } from "../../../../lib/settings/security.js";
import { validateSettingsProviders } from "../../../../lib/settings/validation.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request) {
  try {
    assertSameOriginSettingsRequest(request);
    let body;
    try {
      body = await request.json();
    } catch {
      throw new SettingsError("Request body must be valid JSON.");
    }
    if (body?.providers !== undefined && !Array.isArray(body.providers)) {
      throw new SettingsError("providers must be an array.");
    }
    if (body?.refresh !== undefined && typeof body.refresh !== "boolean") {
      throw new SettingsError("refresh must be a boolean.");
    }
    const results = await validateSettingsProviders(body?.providers, { useCache: body?.refresh !== true });
    return Response.json({ results }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json(
      { error: error.message || "Provider validation failed." },
      {
        status: Number.isInteger(error.status) ? error.status : 502,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}
