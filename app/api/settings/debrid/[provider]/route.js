import {
  beginDebridAuthorization, connectDebridApiKey, disconnectDebrid,
  pollDebridAuthorization, testDebridConnection,
} from "../../../../../lib/debrid/auth.js";
import { DEBRID_PROVIDERS } from "../../../../../lib/debrid/config.js";
import { assertSettingsMutationRequest } from "../../../../../lib/settings/security.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request, context) {
  try {
    assertSettingsMutationRequest(request);
    const { provider } = await context.params;
    if (!DEBRID_PROVIDERS.includes(provider)) {
      return Response.json({ error: "Unknown debrid provider." }, { status: 404 });
    }
    const body = await request.json();
    let result;
    if (body?.action === "start") result = await beginDebridAuthorization(provider);
    else if (body?.action === "poll") result = await pollDebridAuthorization(provider, body.flowId);
    else if (body?.action === "key") {
      result = await connectDebridApiKey(provider, body.apiKey);
    } else if (body?.action === "test") result = await testDebridConnection(provider);
    else if (body?.action === "disconnect") result = await disconnectDebrid(provider);
    else return Response.json({ error: "Invalid provider action." }, { status: 400 });
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof SyntaxError ? "Invalid request body."
      : error.message || "Provider request failed.";
    return Response.json({ error: message }, {
      status: error instanceof SyntaxError ? 400 : Number.isInteger(error.status) ? error.status : 502,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
