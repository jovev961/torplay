import { deleteUsenetJob, getUsenetJob, playUsenetJob } from "../../../../../lib/usenet/jobs.js";
import { assertSameOriginSettingsRequest } from "../../../../../lib/settings/security.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request, context) {
  try {
    const { id } = await context.params;
    const job = await getUsenetJob(id);
    return job ? Response.json(job, { headers: { "Cache-Control": "no-store" } })
      : Response.json({ error: "Usenet job not found." }, { status: 404 });
  } catch (error) { return Response.json({ error: error.message }, { status: error.status || 502 }); }
}

export async function POST(request, context) {
  try {
    assertSameOriginSettingsRequest(request);
    const { id } = await context.params;
    const session = await playUsenetJob(id);
    return session ? Response.json(session) : Response.json({ error: "Usenet job not found." }, { status: 404 });
  } catch (error) { return Response.json({ error: error.message }, { status: error.status || 422 }); }
}

export async function DELETE(request, context) {
  try {
    assertSameOriginSettingsRequest(request);
    const { id } = await context.params;
    return await deleteUsenetJob(id) ? new Response(null, { status: 204 })
      : Response.json({ error: "Usenet job not found." }, { status: 404 });
  } catch (error) { return Response.json({ error: error.message }, { status: error.status || 502 }); }
}
