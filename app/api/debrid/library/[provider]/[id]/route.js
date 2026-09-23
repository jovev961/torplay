import { deleteDebridItem, getDebridItem } from "../../../../../../lib/debrid/library.js";
import { assertSameOriginSettingsRequest, isLocalNetworkSettingsRequest } from "../../../../../../lib/settings/security.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request, context) {
  try {
    if (!isLocalNetworkSettingsRequest(request)) return Response.json({ error: "Debrid Library is only available on the private network." }, { status: 403 });
    const { provider, id } = await context.params;
    const scope = new URL(request.url).searchParams.get("scope");
    const item = await getDebridItem(provider, id, scope ? { selectionScope: scope } : {});
    return item ? Response.json(item, { headers: { "Cache-Control": "no-store" } })
      : Response.json({ error: "Debrid item not found." }, { status: 404 });
  } catch (error) {
    return Response.json({ error: error.message, code: error.code || "DEBRID_ITEM_FAILED" },
      { status: error.status || 502, headers: error.retryAfter ? { "Retry-After": error.retryAfter } : {} });
  }
}

export async function DELETE(request, context) {
  try {
    assertSameOriginSettingsRequest(request);
    if (!isLocalNetworkSettingsRequest(request)) return Response.json({ error: "Debrid Library is only available on the private network." }, { status: 403 });
    const { provider, id } = await context.params;
    return await deleteDebridItem(provider, id) ? new Response(null, { status: 204 })
      : Response.json({ error: "Debrid item not found." }, { status: 404 });
  } catch (error) {
    return Response.json({ error: error.message, code: error.code || "DEBRID_DELETE_FAILED" },
      { status: error.status || 502 });
  }
}
