import { listProfileAvatars } from "../../../lib/profiles/avatar-files.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(
    { avatars: listProfileAvatars() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
