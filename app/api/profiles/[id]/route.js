import { deleteProfile, updateProfile } from "../../../../lib/profiles/service.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(request, context) {
  try {
    const { id } = await context.params;
    return Response.json({ profile: updateProfile(id, await request.json()) });
  } catch (error) {
    return Response.json({ error: error.message || "Could not update the profile." }, { status: error.status || 400 });
  }
}

export async function DELETE(_request, context) {
  const { id } = await context.params;
  deleteProfile(id);
  return new Response(null, { status: 204 });
}
