import { associateDebridItem, dissociateDebridItem } from "../../../../../../../lib/debrid/library.js";
import { assertSettingsMutationRequest } from "../../../../../../../lib/settings/security.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request, context) {
  try {
    assertSettingsMutationRequest(request);
    const { provider, id } = await context.params;
    return Response.json(await associateDebridItem(provider, id, await request.json()));
  } catch (error) {
    return Response.json({ error: error.message || "Could not associate this item." },
      { status: error.status || 502 });
  }
}

export async function DELETE(request, context) {
  try {
    assertSettingsMutationRequest(request);
    const { provider, id } = await context.params;
    return Response.json(await dissociateDebridItem(provider, id));
  } catch (error) {
    return Response.json({ error: error.message || "Could not remove this association." },
      { status: error.status || 502 });
  }
}
