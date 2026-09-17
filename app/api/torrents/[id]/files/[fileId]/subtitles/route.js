import { getVideoFile } from "../../../../../../../lib/torrent/manager.js";
import {
  getSubtitleDiscovery,
  publicSubtitleDiscovery,
  startSubtitleDiscovery,
} from "../../../../../../../lib/subtitles/service.js";
import { getMediaInfo } from "../../../../../../../lib/video/media-info.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function match(context) {
  const { id, fileId } = await context.params;
  return { id, fileId, match: getVideoFile(id, fileId) };
}

export async function POST(_request, context) {
  const { fileId, match: video } = await match(context);
  if (!video) return Response.json({ error: "Playable video file not found." }, { status: 404 });
  const discovery = startSubtitleDiscovery(video.session, video.file, {
    probeMedia: (file) => getMediaInfo(video.session, file),
  });
  return Response.json(publicSubtitleDiscovery(video.session, fileId, discovery), {
    status: discovery.state === "loading" ? 202 : 200,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function GET(_request, context) {
  const { fileId, match: video } = await match(context);
  if (!video) return Response.json({ error: "Playable video file not found." }, { status: 404 });
  const discovery = getSubtitleDiscovery(video.session, fileId);
  if (!discovery) {
    return Response.json({ error: "Subtitle discovery has not started." }, { status: 404 });
  }
  return Response.json(publicSubtitleDiscovery(video.session, fileId, discovery), {
    headers: { "Cache-Control": "no-store" },
  });
}
