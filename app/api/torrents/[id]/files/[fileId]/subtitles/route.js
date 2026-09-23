import { getPlaybackVideoFile } from "../../../../../../../lib/debrid/session.js";
import {
  getSubtitleDiscovery,
  publicSubtitleDiscovery,
  startSubtitleDiscovery,
} from "../../../../../../../lib/subtitles/service.js";
import { getMediaInfo } from "../../../../../../../lib/video/media-info.js";
import { getProfile } from "../../../../../../../lib/profiles/service.js";
import { subtitleConfig } from "../../../../../../../lib/subtitles/config.js";
import { defaultSubtitlePreferences } from "../../../../../../../lib/subtitles/preferences.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function match(context) {
  const { id, fileId } = await context.params;
  return { id, fileId, match: getPlaybackVideoFile(id, fileId) };
}

export async function POST(request, context) {
  const { fileId, match: video } = await match(context);
  if (!video) return Response.json({ error: "Playable video file not found." }, { status: 404 });
  let body = {};
  try {
    body = await request.json();
  } catch {}
  let preferences = defaultSubtitlePreferences();
  if (body?.profileId) {
    const profile = getProfile(body.profileId);
    if (!profile) return Response.json({ error: "Profile not found." }, { status: 404 });
    preferences = profile.subtitlePreferences;
  }
  const discovery = startSubtitleDiscovery(video.session, video.file, {
    config: { ...subtitleConfig(), ...preferences },
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
