import { listDebridLibrary } from "../../../../lib/debrid/library.js";
import { isLocalNetworkSettingsRequest } from "../../../../lib/settings/security.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    if (!isLocalNetworkSettingsRequest(request)) return Response.json({ error: "Debrid Library is only available on the private network." }, { status: 403 });
    const url = new URL(request.url);
    const result = await listDebridLibrary({
      provider: url.searchParams.get("provider") || "all",
      page: Number(url.searchParams.get("page") || 1),
      limit: 50,
      fresh: url.searchParams.get("fresh") === "1",
    });
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error.message }, { status: error.status || 502 });
  }
}
