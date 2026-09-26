import { remotePlaybackOrigin } from "../../../../lib/remote-playback/source.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request) {
  return Response.json(
    { origin: remotePlaybackOrigin(request, process.env) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
