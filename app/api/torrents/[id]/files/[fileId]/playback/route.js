import {
  bufferVideoFile,
  getActiveConversion,
  getInternalFileUrl,
  registerActiveConversion,
  stopActiveConversionForFile,
} from "../../../../../../../lib/torrent/manager.js";
import { getPlaybackVideoFile, getRemoteInternalFileUrl } from "../../../../../../../lib/debrid/session.js";
import {
  createHlsPlaybackJob,
  PlaybackError,
} from "../../../../../../../lib/video/transcode.js";
import {
  getMediaInfo,
  mediaDescriptor,
} from "../../../../../../../lib/video/media-info.js";
import { subtitleConfig } from "../../../../../../../lib/subtitles/config.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(error) {
  const playbackError = error instanceof PlaybackError
    ? error
    : new PlaybackError("FFMPEG_FAILED", error.message || "Playback preparation failed.", {
      status: 502,
    });
  return Response.json(
    { code: playbackError.code, error: playbackError.message },
    { status: playbackError.status },
  );
}

function playbackDetails(id, fileId, job, file, playbackMode) {
  return {
    jobId: job.id,
    state: job.state,
    strategy: job.strategy,
    media: mediaDescriptor(file, playbackMode, job.media),
    inputBytesRead: job.inputBytesRead,
    inputBytesTotal: job.inputBytesTotal,
    originSeconds: job.originSeconds,
    duration: job.media?.duration || null,
    manifestUrl: job.outputDirectory
      ? `/api/torrents/${encodeURIComponent(id)}/files/${encodeURIComponent(fileId)}/hls/index.m3u8?job=${encodeURIComponent(job.id)}`
      : null,
    error: job.error ? { code: job.error.code, message: job.error.message } : null,
  };
}

async function findMatch(context) {
  const { id, fileId } = await context.params;
  return { id, fileId, match: getPlaybackVideoFile(id, fileId) };
}

export async function POST(request, context) {
  const { id, fileId, match } = await findMatch(context);
  if (!match) {
    return Response.json({ code: "NOT_FOUND", error: "Playable video file not found." }, { status: 404 });
  }
  if (match.playbackMode !== "transcode") {
    return Response.json(
      { code: "NATIVE_PLAYBACK", error: "This file uses native HTTP Range playback." },
      { status: 409 },
    );
  }

  const body = await request.json().catch(() => ({}));
  const requestedStart = body?.startTime === undefined ? 0 : Number(body.startTime);
  if (!Number.isFinite(requestedStart) || requestedStart < 0) {
    return Response.json({ code: "INVALID_SEEK", error: "startTime must be a non-negative number." }, { status: 400 });
  }

  let media;
  try {
    media = await getMediaInfo(match.session, match.file);
  } catch (error) {
    return errorResponse(error);
  }
  const startTime = media.duration
    ? Math.min(requestedStart, Math.max(0, media.duration - 0.1))
    : requestedStart;
  const bytesPerSecond = media.duration ? match.file.length / media.duration : 0;
  const startByte = bytesPerSecond ? Math.floor(bytesPerSecond * startTime) : 0;
  const aheadBytes = bytesPerSecond
    ? Math.max(4 * 1024 * 1024, Math.min(64 * 1024 * 1024, bytesPerSecond * subtitleConfig().bufferAheadSeconds))
    : 16 * 1024 * 1024;
  if (match.backend !== "debrid") bufferVideoFile(match.session, match.file, {
    start: startByte,
    end: Math.min(match.file.length - 1, Math.ceil(startByte + aheadBytes)),
  });
  let job = getActiveConversion(match.session, match.file);
  if (job?.state === "failed" || job?.state === "stopped") {
    stopActiveConversionForFile(match.session, match.file);
    job = null;
  }
  if (job && Math.abs(job.originSeconds - startTime) > 0.25) {
    stopActiveConversionForFile(match.session, match.file);
    job = null;
  }
  if (!job) {
    job = createHlsPlaybackJob(match.file, {
      context: `session=${id} file=${fileId} name=${match.file.name}`,
      inputUrl: match.backend === "debrid"
        ? await getRemoteInternalFileUrl(match.session, match.file)
        : getInternalFileUrl(match.session, match.file),
      media,
      startTime,
    });
    registerActiveConversion(match.session, match.file, job);
  }

  try {
    await job.ready;
    return Response.json(playbackDetails(id, fileId, job, match.file, match.playbackMode), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function GET(_request, context) {
  const { id, fileId, match } = await findMatch(context);
  if (!match) {
    return Response.json({ code: "NOT_FOUND", error: "Playable video file not found." }, { status: 404 });
  }
  const job = getActiveConversion(match.session, match.file);
  if (!job) {
    try {
      const media = await getMediaInfo(match.session, match.file);
      return Response.json({
        state: "unprepared",
        media: mediaDescriptor(match.file, match.playbackMode, media),
        duration: media.duration,
        originSeconds: 0,
        manifestUrl: null,
        error: null,
      }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      return errorResponse(error);
    }
  }
  return Response.json(playbackDetails(id, fileId, job, match.file, match.playbackMode), {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function DELETE(_request, context) {
  const { match } = await findMatch(context);
  if (!match) {
    return Response.json({ stopped: false }, { status: 404 });
  }
  return Response.json({
    stopped: stopActiveConversionForFile(match.session, match.file),
  });
}
