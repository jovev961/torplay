import { networkAccessDetails } from "../../../lib/network/access.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request) {
  return Response.json(networkAccessDetails(request), {
    headers: { "Cache-Control": "no-store" },
  });
}
