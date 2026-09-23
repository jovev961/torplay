import {
  SettingsError,
  validateAndUpdateProvidersSettings,
} from "../../../lib/settings/config.js";
import { assertSettingsMutationRequest } from "../../../lib/settings/security.js";
import { clearSettingsValidation, validateSettingsProviders } from "../../../lib/settings/validation.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const setupFields = {
  tmdb: new Set(["apiToken"]),
};

function setupChanges(body) {
  const providers = body?.providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
    throw new SettingsError("Required provider settings are missing.");
  }
  const unknownProvider = Object.keys(providers).find((id) => !setupFields[id]);
  if (unknownProvider) throw new SettingsError("Setup contains an unknown provider.");
  return Object.entries(setupFields).filter(([id]) => id === "tmdb" || providers[id]).map(([providerId, allowed]) => {
    const values = providers[providerId] || {};
    if (typeof values !== "object" || Array.isArray(values)) {
      throw new SettingsError("Provider settings must be an object.");
    }
    if (Object.keys(values).some((id) => !allowed.has(id))) {
      throw new SettingsError("Setup contains an unknown field.");
    }
    return { providerId, payload: { values } };
  });
}

export async function POST(request) {
  try {
    assertSettingsMutationRequest(request);
    let body;
    try {
      body = await request.json();
    } catch {
      throw new SettingsError("Request body must be valid JSON.");
    }
    const outcome = await validateAndUpdateProvidersSettings(setupChanges(body), async (environment) => {
      const results = await validateSettingsProviders(["tmdb"], {
        environment,
        useCache: false,
      });
      return { valid: results.every((item) => item.status === "valid"), results };
    });
    if (!outcome.committed) {
      return Response.json(
        { error: "Fix the provider settings that could not be verified.", ready: false, results: outcome.validation.results },
        { status: 422, headers: { "Cache-Control": "no-store" } },
      );
    }
    clearSettingsValidation("tmdb");
    return Response.json(
      { ready: true, results: outcome.validation.results },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return Response.json(
      { error: error.message || "Setup could not be completed." },
      {
        status: Number.isInteger(error.status) ? error.status : 500,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}
