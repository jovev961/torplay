import {
  beginStream,
  getVideoFile,
} from "../../../../../../../../lib/torrent/manager.js";
import { subtitleConfig } from "../../../../../../../../lib/subtitles/config.js";
import { loadSubtitleTrack } from "../../../../../../../../lib/subtitles/service.js";
import { shiftWebVtt } from "../../../../../../../../lib/video/subtitles.js";
import { embeddedSubtitleExtractor } from "../../../../../../../../lib/video/media-info.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request, context) {
  const { id, fileId, trackId } = await context.params;
  const match = getVideoFile(id, fileId);
  if (!match) return Response.json({ error: "Playable video file not found." }, { status: 404 });

  const offsetMs = Number(new URL(request.url).searchParams.get("offsetMs") || 0);
  if (!Number.isFinite(offsetMs) || Math.abs(offsetMs) > 24 * 60 * 60 * 1000) {
    return Response.json({ error: "Subtitle offset is invalid." }, { status: 400 });
  }

  const finish = beginStream(match.session);
  try {
    const loaded = await loadSubtitleTrack(match.session, fileId, trackId, {
      config: subtitleConfig(),
      extractEmbedded: embeddedSubtitleExtractor(match.session, match.file),
    });
    if (!loaded) return Response.json({ error: "Subtitle track not found." }, { status: 404 });
    return new Response(shiftWebVtt(loaded.body, offsetMs), {
      headers: {
        "Cache-Control": "private, max-age=300",
        "Content-Type": "text/vtt; charset=utf-8",
      },
    });
  } catch (error) {
    return Response.json({ error: error.message || "Subtitle could not be loaded." }, {
      status: Number.isInteger(error.status) ? error.status : 502,
    });
  } finally {
    finish();
  }
}
