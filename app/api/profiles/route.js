import { createProfile, listProfiles } from "../../../lib/profiles/service.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return Response.json({ profiles: listProfiles() }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Profiles are temporarily unavailable." }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const profile = createProfile(await request.json());
    return Response.json({ profile }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error.message || "Could not create the profile." }, { status: error.status || 400 });
  }
}
