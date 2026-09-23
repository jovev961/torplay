import { getSearchResult } from "../../../lib/search/result-store.js";
import { startPlaybackSource } from "../../../lib/debrid/session.js";
import { assertSettingsMutationRequest } from "../../../lib/settings/security.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request) {
  try { assertSettingsMutationRequest(request); }
  catch (error) { return Response.json({ error: error.message }, { status: error.status || 403 }); }
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const source = getSearchResult(body?.resultId);
  if (!source) {
    return Response.json(
      { error: "That search result expired or is invalid. Search again." },
      { status: 404 },
    );
  }

  try {
    if (body?.action && !["local", "remote"].includes(body.action)) {
      return Response.json({ error: "Invalid playback action." }, { status: 400 });
    }
    if (body?.provider && !["real-debrid", "torbox"].includes(body.provider)) {
      return Response.json({ error: "Invalid provider." }, { status: 400 });
    }
    const result = await startPlaybackSource(source, {
      action: body.action, remoteProvider: body.provider, scope: body.scope,
    });
    return Response.json(result, {
      status: result.status === "loading" || result.kind === "debrid-job" ? 202 : 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return Response.json({
      code: error.code || "PLAYBACK_START_FAILED",
      error: error.message || "Could not start playback.",
    }, { status: Number.isInteger(error.status) ? error.status : 422 });
  }
}
