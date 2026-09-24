import { inspectTorrentAvailability } from "../../../../lib/debrid/availability.js";
import { assertSettingsMutationRequest } from "../../../../lib/settings/security.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request) {
  try {
    assertSettingsMutationRequest(request);
    const body = await request.json();
    const result = await inspectTorrentAvailability(body?.resultIds,
      { resolveUnknown: body?.resolveUnknown === true });
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error.message || "Could not check torrent availability." },
      { status: error.status || 502 });
  }
}
