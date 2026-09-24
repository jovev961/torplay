import { inspectDirectDebridAvailability, resolveDirectDebridPlayback } from "../../../../lib/debrid/library.js";
import { assertSettingsMutationRequest, isLocalNetworkSettingsRequest } from "../../../../lib/settings/security.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    if (!isLocalNetworkSettingsRequest(request)) {
      return Response.json({ error: "Ready Debrid sources are only available on the private network." }, { status: 403 });
    }
    const params = new URL(request.url).searchParams;
    const result = await inspectDirectDebridAvailability({
      type: params.get("type"), tmdbId: params.get("tmdbId"),
      season: params.get("season"), episode: params.get("episode"),
    });
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error.message || "Could not check debrid sources." },
      { status: error.status || 502 });
  }
}

export async function POST(request) {
  try {
    assertSettingsMutationRequest(request);
    const body = await request.json();
    if (!["real-debrid", "torbox"].includes(body?.provider)
      || typeof body?.resourceId !== "string" || !body.resourceId) {
      return Response.json({ error: "Choose a ready Debrid source." }, { status: 400 });
    }
    const result = await resolveDirectDebridPlayback(body, {
      selection: { provider: body.provider, resourceId: body.resourceId },
    });
    if (result.kind !== "hit") {
      return Response.json({ error: "That Debrid source is no longer ready. Choose another source." }, { status: 409 });
    }
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error.message || "Could not check debrid playback." },
      { status: error.status || 502 });
  }
}
