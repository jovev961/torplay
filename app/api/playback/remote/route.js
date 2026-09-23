import { remotePlaybackOrigin } from "../../../../lib/remote-playback/source.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request) {
  if (process.env.TORPLAY_DISTRIBUTION === "linux-appimage") {
    return Response.json(
      { error: "Remote playback is unavailable in the desktop-local Linux AppImage." },
      { status: 409, headers: { "Cache-Control": "no-store" } },
    );
  }
  return Response.json(
    { origin: remotePlaybackOrigin(request, process.env) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
