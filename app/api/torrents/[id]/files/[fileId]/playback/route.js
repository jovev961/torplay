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
import { audioTrackByIndex, selectAudioTrack } from "../../../../../../../lib/video/audio-tracks.js";
import { choosePlaybackStrategy, playbackPlanKey } from "../../../../../../../lib/video/playback-strategy.js";

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

function playbackDetails(id, fileId, job, file, match) {
  return {
    jobId: job.id,
    state: job.state,
    strategy: job.strategy,
    delivery: "hls",
    playbackPlan: job.plan,
    media: mediaDescriptor(file, match.playbackMode, job.media, job.audioStreamIndex, match.sourceMimeType),
    inputBytesRead: job.inputBytesRead,
    inputBytesTotal: job.inputBytesTotal,
    originSeconds: job.originSeconds,
    startOffsetSeconds: job.startOffsetSeconds || 0,
    duration: job.media?.duration || null,
    selectedAudioStreamIndex: job.audioStreamIndex,
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
  const hasRequestedAudio = body?.audioStreamIndex !== undefined && body?.audioStreamIndex !== null;
  const selectedAudio = hasRequestedAudio
    ? audioTrackByIndex(media.audioStreams, body.audioStreamIndex)
    : selectAudioTrack(media.audioStreams);
  if (hasRequestedAudio && !selectedAudio) {
    return Response.json(
      { code: "INVALID_AUDIO_TRACK", error: "Choose a valid audio track." },
      { status: 400 },
    );
  }
  const audioStreamIndex = selectedAudio?.index ?? null;
  const failedStrategies = Array.isArray(body?.failedStrategies)
    ? body.failedStrategies.filter((value) => ["direct", "remux", "selective-transcode"].includes(value))
    : [];
  const failedAudioCodecs = Array.isArray(body?.failedAudioCodecs)
    ? body.failedAudioCodecs.filter((value) => ["eac3", "ac3"].includes(value))
    : [];
  const plan = choosePlaybackStrategy(media, body?.capabilities, {
    audioStreamIndex,
    failedStrategies,
    failedAudioCodecs,
    allowUnknown: true,
  });
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
  if (plan.delivery === "direct") {
    stopActiveConversionForFile(match.session, match.file);
    return Response.json({
      state: "ready",
      strategy: plan.name,
      delivery: "direct",
      playbackPlan: plan,
      media: mediaDescriptor(match.file, match.playbackMode, media, audioStreamIndex, match.sourceMimeType),
      originSeconds: 0,
      duration: media.duration,
      selectedAudioStreamIndex: audioStreamIndex,
      sourceUrl: `/api/torrents/${encodeURIComponent(id)}/files/${encodeURIComponent(fileId)}/stream?direct=1`,
      manifestUrl: null,
      error: null,
    }, { headers: { "Cache-Control": "no-store" } });
  }
  let job = getActiveConversion(match.session, match.file);
  if (job?.state === "failed" || job?.state === "stopped") {
    stopActiveConversionForFile(match.session, match.file);
    job = null;
  }
  if (job && Math.abs(job.requestedStartSeconds - startTime) > 0.25) {
    stopActiveConversionForFile(match.session, match.file);
    job = null;
  }
  if (job && job.audioStreamIndex !== audioStreamIndex) {
    stopActiveConversionForFile(match.session, match.file);
    job = null;
  }
  if (job && job.planKey !== playbackPlanKey(plan)) {
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
      audioStreamIndex,
      plan,
    });
    registerActiveConversion(match.session, match.file, job);
  }

  try {
    await job.ready;
    return Response.json(playbackDetails(id, fileId, job, match.file, match), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const playbackError = error instanceof PlaybackError
      ? error : new PlaybackError("FFMPEG_FAILED", error.message || "Playback preparation failed.", { status: 502 });
    return Response.json({
      code: playbackError.code,
      error: playbackError.message,
      strategy: plan.name,
      playbackPlan: plan,
    }, { status: playbackError.status });
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
        media: mediaDescriptor(
          match.file,
          match.playbackMode,
          media,
          selectAudioTrack(media.audioStreams)?.index ?? null,
          match.sourceMimeType,
        ),
        duration: media.duration,
        originSeconds: 0,
        manifestUrl: null,
        error: null,
      }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      return errorResponse(error);
    }
  }
  return Response.json(playbackDetails(id, fileId, job, match.file, match), {
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
