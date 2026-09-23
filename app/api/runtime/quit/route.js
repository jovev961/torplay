import { assertSettingsMutationRequest } from "../../../../lib/settings/security.js";
import { sendControlCommand } from "../../../../scripts/runtime-control.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request) {
  if (process.env.TORPLAY_DISTRIBUTION !== "linux-appimage") {
    return Response.json({ error: "Quit is available only in the Linux AppImage." }, { status: 404 });
  }
  try {
    assertSettingsMutationRequest(request);
    await sendControlCommand({ endpoint: process.env.TORPLAY_CONTROL_ENDPOINT });
    return Response.json({ status: "stopping" }, { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error.message || "TorPlay could not quit." }, {
      status: Number.isInteger(error.status) ? error.status : 503,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
