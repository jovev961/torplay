import { getPlaybackMappingTarget } from "../../../../../lib/debrid/session.js";
import { saveEpisodeFileMapping } from "../../../../../lib/video/episode-mapping.js";
import { assertSettingsMutationRequest } from "../../../../../lib/settings/security.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request, context) {
  try { assertSettingsMutationRequest(request); }
  catch (error) { return Response.json({ error: error.message }, { status: error.status || 403 }); }
  const { id } = await context.params;
  const target = getPlaybackMappingTarget(id);
  if (!target) return Response.json({ error: "Playback session not found." }, { status: 404 });
  const body = await request.json().catch(() => null);
  const file = target.files.find((entry) => entry.id === String(body?.fileId));
  if (!file || target.mediaContext?.type !== "show") {
    return Response.json({ error: "Choose a video file from this show session." }, { status: 422 });
  }
  if (!target.infoHash || !target.mediaContext.tmdbId) {
    return Response.json({ fileId: file.id, remembered: false });
  }
  try {
    saveEpisodeFileMapping(target.infoHash, target.mediaContext, file);
    return Response.json({ fileId: file.id, remembered: true });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 422 });
  }
}
