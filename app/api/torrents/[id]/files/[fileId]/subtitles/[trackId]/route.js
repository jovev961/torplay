import {
  beginStream,
  getVideoFile,
} from "../../../../../../../../lib/torrent/manager.js";
import { subtitleConfig } from "../../../../../../../../lib/subtitles/config.js";
import { loadSubtitleTrack } from "../../../../../../../../lib/subtitles/service.js";
import { embeddedSubtitleExtractor } from "../../../../../../../../lib/video/media-info.js";
import {
  remoteMediaOptionsResponse,
  withRemoteMediaCors,
} from "../../../../../../../../lib/remote-playback/cors.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function respond(context) {
  const { id, fileId, trackId } = await context.params;
  const match = getVideoFile(id, fileId);
  if (!match) return Response.json({ error: "Playable video file not found." }, { status: 404 });

  const finish = beginStream(match.session);
  try {
    const loaded = await loadSubtitleTrack(match.session, fileId, trackId, {
      config: subtitleConfig(),
      extractEmbedded: embeddedSubtitleExtractor(match.session, match.file),
    });
    if (!loaded) return Response.json({ error: "Subtitle track not found." }, { status: 404 });
    return new Response(loaded.body, {
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

export async function GET(_request, context) {
  return withRemoteMediaCors(await respond(context));
}

export async function HEAD(_request, context) {
  return withRemoteMediaCors(await respond(context), { includeBody: false });
}

export function OPTIONS() {
  return remoteMediaOptionsResponse();
}
