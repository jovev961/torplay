import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import ffmpegStaticPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import { subtitleToWebVtt } from "./subtitles.js";
import { audioTrackByIndex, normalizeAudioLanguage, selectAudioTrack } from "./audio-tracks.js";
import { playbackPlanKey } from "./playback-strategy.js";

const PREBUFFER_BYTES = 16 * 1024 * 1024;
const PREBUFFER_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 60_000;
const HLS_START_TIMEOUT_MS = 120_000;
const FORCE_KILL_DELAY_MS = 2_000;
const HLS_SEGMENT_SECONDS = 4;
const HLS_START_SEGMENTS = 3;
const TORRENT_READ_CHUNK_BYTES = 8 * 1024 * 1024;
const TORRENT_READ_STALL_TIMEOUT_MS = 120_000;
const TORRENT_READ_RETRY_DELAY_MS = 250;

export class PlaybackError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "PlaybackError";
    this.code = code;
    this.status = options.status ?? 500;
  }
}

function resolveExecutable(configured, bundled, name) {
  const executable = configured?.trim() || bundled;
  if (!executable) {
    throw new PlaybackError(
      `${name.toUpperCase()}_UNAVAILABLE`,
      `${name} is unavailable. Reinstall dependencies or configure ${name.toUpperCase()}_PATH.`,
      { status: 503 },
    );
  }

  try {
    accessSync(executable, constants.X_OK);
  } catch {
    throw new PlaybackError(
      `${name.toUpperCase()}_UNAVAILABLE`,
      `${name} is unavailable. Reinstall dependencies or configure ${name.toUpperCase()}_PATH.`,
      { status: 503 },
    );
  }
  return executable;
}

export function resolveFfmpegPath() {
  return resolveExecutable(process.env.FFMPEG_PATH, ffmpegStaticPath, "FFmpeg");
}

export function resolveFfprobePath() {
  return resolveExecutable(process.env.FFPROBE_PATH, ffprobeStatic?.path, "FFprobe");
}

const ffmpegFilterCache = new Map();

function executableHasFilter(executable, filter) {
  const key = `${executable}:${filter}`;
  if (ffmpegFilterCache.has(key)) return ffmpegFilterCache.get(key);
  const result = spawnSync(executable, ["-hide_banner", "-filters"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  const supported = result.status === 0
    && new RegExp(`(?:^|\\s)${filter}(?:\\s|$)`, "m").test(output);
  ffmpegFilterCache.set(key, supported);
  return supported;
}

function needsHdrToneMap(media, plan) {
  return Boolean(media?.video?.hdrFormat && media.video.colorTransfer
    && !["copy", "use-compatible-base-layer"].includes(plan?.videoAction));
}

export function resolvePlaybackFfmpegPath(media, plan, options = {}) {
  const primary = options.ffmpegPath ?? resolveFfmpegPath();
  if (!needsHdrToneMap(media, plan)) return primary;
  const hasFilter = options.hasFilter || executableHasFilter;
  if (hasFilter(primary, "zscale")) return primary;
  const bundled = resolveExecutable(null, ffmpegStaticPath, "FFmpeg");
  if (bundled !== primary && hasFilter(bundled, "zscale")) {
    console.warn("Configured FFmpeg lacks zscale; using bundled FFmpeg for HDR tone mapping.", {
      configured: primary,
    });
    return bundled;
  }
  throw new PlaybackError(
    "HDR_TONEMAP_UNAVAILABLE",
    "HDR compatibility conversion requires an FFmpeg build with the zscale filter.",
    { status: 503 },
  );
}

export function buildFfprobeArgs(input = "pipe:0") {
  return [
    "-v", "error",
    "-probesize", "33554432",
    "-analyzeduration", "30000000",
    "-show_format",
    "-show_streams",
    "-of", "json",
    input,
  ];
}

export function parseProbeOutput(stdout) {
  let result;
  try {
    result = JSON.parse(stdout);
  } catch (error) {
    throw new PlaybackError("PROBE_FAILED", "FFprobe returned invalid media information.", {
      cause: error,
      status: 502,
    });
  }

  const streams = Array.isArray(result.streams) ? result.streams : [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const audioStreams = streams
    .map((stream, position) => ({
      stream,
      index: Number.isInteger(Number(stream.index)) ? Number(stream.index) : position,
    }))
    .filter(({ stream }) => stream.codec_type === "audio")
    .map(({ stream, index }, ordinal) => {
      const title = typeof stream.tags?.title === "string" ? stream.tags.title.trim() || null : null;
      const disposition = stream.disposition || {};
      const sideData = Array.isArray(stream.side_data_list) ? stream.side_data_list : [];
      const atmosEvidence = [stream.profile, ...sideData.map((entry) => entry.side_data_type)]
        .filter(Boolean).find((value) => /(?:atmos|\bjoc\b)/i.test(String(value))) || null;
      return {
        index,
        ordinal,
        codec: stream.codec_name ? String(stream.codec_name).toLowerCase() : "unknown",
        profile: stream.profile || null,
        language: normalizeAudioLanguage(stream.tags?.language),
        title,
        channels: Number.isInteger(Number(stream.channels)) && Number(stream.channels) > 0
          ? Number(stream.channels) : null,
        channelLayout: stream.channel_layout || null,
        sampleRate: Number.isFinite(Number(stream.sample_rate)) && Number(stream.sample_rate) > 0
          ? Number(stream.sample_rate) : null,
        bitRate: Number.isFinite(Number(stream.bit_rate)) && Number(stream.bit_rate) > 0
          ? Number(stream.bit_rate) : null,
        atmos: atmosEvidence ? true : null,
        atmosEvidence,
        default: Boolean(disposition.default),
        commentary: Boolean(disposition.comment) || /\bcommentary\b/i.test(title || ""),
        audioDescription: Boolean(disposition.visual_impaired || disposition.descriptions)
          || /\b(audio description|descriptive audio|described video)\b/i.test(title || ""),
      };
    });
  const audio = selectAudioTrack(audioStreams);
  if (!video?.codec_name) {
    throw new PlaybackError(
      "UNSUPPORTED_STREAMS",
      "The selected file does not contain a supported video stream.",
      { status: 422 },
    );
  }

  const duration = Number(result.format?.duration || video.duration);
  const videoSideData = Array.isArray(video.side_data_list) ? video.side_data_list : [];
  const dolbyVisionData = videoSideData.find((entry) => /dovi configuration record/i.test(entry.side_data_type || ""));
  const hdr10Plus = videoSideData.some((entry) => /(?:smpte\s*2094-40|hdr10\+)/i.test(entry.side_data_type || ""));
  const masteringDisplay = videoSideData.some((entry) => /mastering display metadata/i.test(entry.side_data_type || ""));
  const colorTransfer = String(video.color_transfer || "").toLowerCase() || null;
  const colorPrimaries = String(video.color_primaries || "").toLowerCase() || null;
  const hdr10 = colorTransfer === "smpte2084" && (colorPrimaries === "bt2020" || masteringDisplay);
  const hlg = colorTransfer === "arib-std-b67";
  const compatibilityId = Number(dolbyVisionData?.dv_bl_signal_compatibility_id);
  const baseLayerCompatibility = compatibilityId === 1 ? "hdr10"
    : compatibilityId === 2 ? "sdr" : compatibilityId === 4 ? "hlg" : null;
  const dolbyVision = dolbyVisionData ? {
    profile: Number.isFinite(Number(dolbyVisionData.dv_profile)) ? Number(dolbyVisionData.dv_profile) : null,
    level: Number.isFinite(Number(dolbyVisionData.dv_level)) ? Number(dolbyVisionData.dv_level) : null,
    rpuPresent: Boolean(Number(dolbyVisionData.rpu_present_flag)),
    enhancementLayerPresent: Boolean(Number(dolbyVisionData.el_present_flag)),
    baseLayerPresent: Boolean(Number(dolbyVisionData.bl_present_flag)),
    compatibilityId: Number.isFinite(compatibilityId) ? compatibilityId : null,
    baseLayerCompatibility,
  } : null;
  const frameRateParts = String(video.avg_frame_rate || video.r_frame_rate || "").split("/").map(Number);
  const frameRate = frameRateParts.length === 2 && frameRateParts[1] > 0
    ? frameRateParts[0] / frameRateParts[1] : null;
  const bitDepthMatch = /p(\d{2})(?:le|be)?$/i.exec(String(video.pix_fmt || ""));
  const bitDepth = Number(video.bits_per_raw_sample) || Number(bitDepthMatch?.[1]) || null;
  const videoDetails = {
    codec: String(video.codec_name).toLowerCase(),
    codecTag: video.codec_tag_string || null,
    profile: video.profile || null,
    level: Number.isFinite(Number(video.level)) ? Number(video.level) : null,
    width: Number(video.width) || null,
    height: Number(video.height) || null,
    frameRate: Number.isFinite(frameRate) && frameRate > 0 ? frameRate : null,
    bitRate: Number(video.bit_rate) || null,
    pixelFormat: video.pix_fmt || null,
    bitDepth,
    colorRange: video.color_range || null,
    colorSpace: video.color_space || null,
    colorTransfer,
    colorPrimaries,
    dolbyVision,
    hdrFormat: dolbyVision ? "dolby-vision" : hdr10Plus ? "hdr10-plus"
      : hdr10 ? "hdr10" : hlg ? "hlg" : null,
    hdr10Plus,
    masteringDisplay,
  };
  const textSubtitleCodecs = new Set(["ass", "ssa", "subrip", "text", "webvtt", "mov_text"]);
  return {
    container: result.format?.format_name || "unknown",
    videoCodec: String(video.codec_name).toLowerCase(),
    video: videoDetails,
    audioCodec: audio?.codec || null,
    audioStreams,
    duration: Number.isFinite(duration) && duration > 0 ? duration : null,
    subtitleStreams: streams
      .filter((stream) => stream.codec_type === "subtitle")
      .map((stream) => ({
        index: stream.index,
        codec: String(stream.codec_name || "unknown").toLowerCase(),
        language: stream.tags?.language || "und",
        title: stream.tags?.title || null,
        hearingImpaired: Boolean(stream.disposition?.hearing_impaired),
        textBased: textSubtitleCodecs.has(String(stream.codec_name || "").toLowerCase()),
      })),
  };
}

export function chooseHlsStrategy(media, options = {}) {
  if (options.plan) {
    const copyVideo = ["copy", "use-compatible-base-layer"].includes(options.plan.videoAction);
    const copyAudio = options.plan.audioAction === "copy" || options.plan.audioAction === "none";
    return { copyVideo, copyAudio, name: options.plan.name };
  }
  // Stream-copy seeks begin on a preceding keyframe, so their first frame does
  // not reliably match a requested resume/seek origin. Decode nonzero starts.
  const accurateSeek = Number(options.startTime) > 0;
  const copyVideo = media.videoCodec === "h264" && !accurateSeek;
  const selectedAudio = audioTrackByIndex(media.audioStreams, options.audioStreamIndex)
    || selectAudioTrack(media.audioStreams);
  const audioCodec = selectedAudio?.codec || media.audioCodec;
  const copyAudio = (!audioCodec || audioCodec === "aac") && !accurateSeek;
  return {
    copyVideo,
    copyAudio,
    name: copyVideo && copyAudio ? "remux" : "transcode",
  };
}

export function buildFfmpegArgs(media, outputDirectory, options = {}) {
  const strategy = chooseHlsStrategy(media, options);
  const plan = options.plan || {
    name: strategy.name,
    videoAction: strategy.copyVideo ? "copy" : "transcode-h264",
    audioAction: strategy.copyAudio ? "copy" : "transcode-aac-stereo",
    segmentFormat: "mpegts",
  };
  const selectedAudio = audioTrackByIndex(media.audioStreams, options.audioStreamIndex)
    || selectAudioTrack(media.audioStreams);
  const audioCodec = selectedAudio?.codec || media.audioCodec;
  const args = [
    "-hide_banner",
    "-loglevel", "error",
    "-fflags", "+genpts",
    "-readrate", String(options.readRate ?? 1.5),
  ];
  if (Number(options.startTime) > 0) args.push("-ss", String(options.startTime));
  args.push(
    "-i", options.inputUrl || "pipe:0",
    "-map", "0:v:0",
  );
  if (audioCodec) args.push("-map", selectedAudio ? `0:${selectedAudio.index}` : "0:a:0?");
  args.push("-map_metadata", "0", "-sn", "-dn");

  if (["copy", "use-compatible-base-layer"].includes(plan.videoAction)) {
    args.push("-c:v", "copy");
    if (plan.segmentFormat === "fmp4" && media.videoCodec === "hevc") {
      args.push("-tag:v", plan.videoAction === "use-compatible-base-layer"
        ? "hvc1" : media.video?.dolbyVision ? "dvh1" : "hvc1");
    }
  } else {
    if (media.video?.hdrFormat && media.video?.colorTransfer) {
      // Reduce UHD frames before the expensive floating-point tone map. A
      // full-resolution software tone map frequently cannot remain real-time,
      // which makes TV clients catch the HLS live edge and stall indefinitely.
      args.push("-vf", "zscale=w='min(1920,iw)':h=-2:t=linear:npl=100,format=gbrpf32le,tonemap=tonemap=hable:desat=0,zscale=p=bt709:t=bt709:m=bt709:r=tv,format=yuv420p");
    } else if (Number(media.video?.width) > 1920) {
      args.push("-vf", "scale=w='min(1920,iw)':h=-2");
    }
    args.push(
      "-c:v", "libx264",
      "-preset", "superfast",
      "-crf", "23",
      "-pix_fmt", "yuv420p",
      "-force_key_frames", `expr:gte(t,n_forced*${HLS_SEGMENT_SECONDS})`,
    );
  }

  if (audioCodec) {
    if (plan.audioAction === "copy") {
      args.push("-c:a", "copy");
    } else if (plan.audioAction === "transcode-eac3") {
      args.push("-c:a", "eac3", "-b:a", "640k", "-ac", String(Math.min(6, selectedAudio?.channels || 6)));
    } else if (plan.audioAction === "transcode-ac3") {
      args.push("-c:a", "ac3", "-b:a", "640k", "-ac", String(Math.min(6, selectedAudio?.channels || 6)));
    } else if (plan.audioAction === "transcode-aac") {
      args.push("-c:a", "aac", "-b:a", "384k", "-ac", String(Math.min(6, selectedAudio?.channels || 2)));
    } else {
      args.push("-c:a", "aac", "-b:a", "160k", "-ac", "2");
    }
  }

  args.push(
    "-avoid_negative_ts", "make_zero",
    "-max_muxing_queue_size", "2048",
    "-f", "hls",
    "-hls_time", String(HLS_SEGMENT_SECONDS),
    "-hls_list_size", "0",
    "-hls_playlist_type", "event",
    "-hls_flags", "independent_segments+temp_file",
  );
  if (plan.segmentFormat === "fmp4") {
    args.push(
      "-hls_segment_type", "fmp4",
      "-hls_fmp4_init_filename", "init.mp4",
      "-hls_segment_filename", path.join(outputDirectory, "segment-%05d.m4s"),
    );
  } else {
    args.push("-hls_segment_filename", path.join(outputDirectory, "segment-%05d.ts"));
  }
  args.push(path.join(outputDirectory, "index.m3u8"));
  return args;
}

function logProcessResult(name, context, result) {
  const prefix = `[${name}] ${context || "video"}`;
  const summary = `${prefix} exited code=${result.code ?? "null"} signal=${result.signal ?? "null"}`;
  if (result.code === 0 && !result.error) console.info(summary);
  else console.error(summary, result.error || "");
  if (result.stderr) console.error(`${prefix} stderr:\n${result.stderr}`);
}

function killProcess(child) {
  if (child.exitCode !== null || child.killed) return;
  child.kill("SIGTERM");
  const timer = setTimeout(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  }, FORCE_KILL_DELAY_MS);
  timer.unref?.();
}

function waitForProcess(child, stderrChunks, context, name) {
  return new Promise((resolve) => {
    let settled = false;
    let processError = null;
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      const result = {
        code,
        signal,
        error: processError,
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      };
      logProcessResult(name, context, result);
      resolve(result);
    };
    child.once("error", (error) => {
      processError = error;
      finish(null, null);
    });
    child.once("close", finish);
  });
}

export function waitForTorrentBuffer(file, options = {}) {
  const target = Math.min(file.length, options.bytes ?? PREBUFFER_BYTES);
  const timeoutMs = options.timeoutMs ?? PREBUFFER_TIMEOUT_MS;
  if (!Number.isFinite(target) || target <= 0) {
    return Promise.reject(new PlaybackError(
      "UNSUPPORTED_STREAMS",
      "The selected video file is empty.",
      { status: 422 },
    ));
  }

  return new Promise((resolve, reject) => {
    const input = file.createReadStream({ start: 0, end: target - 1 });
    let received = 0;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.destroy();
      if (error) reject(error);
      else resolve({ bytes: received, target });
    };
    const timer = setTimeout(() => {
      finish(new PlaybackError(
        "INSUFFICIENT_TORRENT_DATA",
        `Torrent data is arriving too slowly for playback (${received} of ${target} startup bytes available).`,
        { status: 504 },
      ));
    }, timeoutMs);
    timer.unref?.();

    input.on("data", (chunk) => {
      received += chunk.length;
      if (received >= target) finish();
    });
    input.once("end", () => {
      if (received < target) {
        finish(new PlaybackError(
          "INSUFFICIENT_TORRENT_DATA",
          `The torrent stream ended before enough startup data was available (${received} of ${target} bytes).`,
          { status: 502 },
        ));
      }
    });
    input.once("error", (error) => {
      if (!settled) {
        finish(new PlaybackError(
          "INSUFFICIENT_TORRENT_DATA",
          `Torrent data could not be buffered: ${error.message}`,
          { cause: error, status: 502 },
        ));
      }
    });
  });
}

function nextWithTimeout(iterator, input, timeoutMs, bytesRead, totalBytes) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      input.destroy();
      reject(new PlaybackError(
        "INSUFFICIENT_TORRENT_DATA",
        `Torrent data stalled during playback (${bytesRead} of ${totalBytes} bytes available to FFmpeg).`,
        { status: 504 },
      ));
    }, timeoutMs);
    timer.unref?.();
    iterator.next().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function createContinuousTorrentStream(file, options = {}) {
  const chunkBytes = options.chunkBytes ?? TORRENT_READ_CHUNK_BYTES;
  const stallTimeoutMs = options.stallTimeoutMs ?? TORRENT_READ_STALL_TIMEOUT_MS;
  const retryDelayMs = options.retryDelayMs ?? TORRENT_READ_RETRY_DELAY_MS;

  async function* readRanges() {
    let offset = 0;
    let noProgressSince = null;
    while (offset < file.length) {
      const rangeEnd = Math.min(file.length - 1, offset + chunkBytes - 1);
      const input = file.createReadStream({ start: offset, end: rangeEnd });
      const iterator = input[Symbol.asyncIterator]();
      let rangeProgress = false;
      try {
        while (offset <= rangeEnd) {
          noProgressSince ??= Date.now();
          const remainingStallMs = Math.max(
            1,
            stallTimeoutMs - (Date.now() - noProgressSince),
          );
          const { done, value } = await nextWithTimeout(
            iterator,
            input,
            remainingStallMs,
            offset,
            file.length,
          );
          if (done) break;

          const available = Buffer.from(value);
          const remainingRangeBytes = rangeEnd - offset + 1;
          const chunk = available.length > remainingRangeBytes
            ? available.subarray(0, remainingRangeBytes)
            : available;
          if (chunk.length === 0) continue;
          offset += chunk.length;
          noProgressSince = null;
          rangeProgress = true;
          options.onProgress?.(offset, file.length);
          yield chunk;
        }
      } catch (error) {
        if (error instanceof PlaybackError) throw error;
      } finally {
        input.destroy();
        try {
          await iterator.return?.();
        } catch {
          // A failed range will be retried from the last delivered byte.
        }
      }

      if (offset <= rangeEnd) {
        noProgressSince ??= Date.now();
        if (Date.now() - noProgressSince >= stallTimeoutMs) {
          throw new PlaybackError(
            "INSUFFICIENT_TORRENT_DATA",
            `Torrent input ended early (${offset} of ${file.length} bytes delivered to FFmpeg).`,
            { status: 504 },
          );
        }
        if (!rangeProgress) {
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        }
      }
    }
  }

  return Readable.from(readRanges());
}

export function getFfmpegPlaybackError(result, inputBytesRead, inputBytesTotal) {
  const incompleteInput = inputBytesRead < inputBytesTotal;
  const prematureInput = /file ended prematurely/i.test(result.stderr || "");
  if (incompleteInput) {
    return new PlaybackError(
      "INSUFFICIENT_TORRENT_DATA",
      `The torrent input ended early (${inputBytesRead} of ${inputBytesTotal} bytes reached FFmpeg).`,
      { cause: result.error, status: 502 },
    );
  }
  if (prematureInput) {
    return new PlaybackError(
      "FFMPEG_FAILED",
      "FFmpeg found a truncated or corrupt video stream even though the torrent input completed.",
      { cause: result.error, status: 502 },
    );
  }
  if (result.error || result.code !== 0) {
    return new PlaybackError(
      "FFMPEG_FAILED",
      `FFmpeg could not prepare this video (exit ${result.code ?? "unavailable"}).`,
      { cause: result.error, status: 502 },
    );
  }
  return null;
}

export async function probeVideoFile(file, options = {}) {
  const executable = options.ffprobePath ?? resolveFfprobePath();
  const spawnProcess = options.spawnProcess ?? spawn;
  const context = options.context ?? file.name ?? "video";
  const input = options.inputUrl ? null : file.createReadStream();
  const child = spawnProcess(executable, buildFfprobeArgs(options.inputUrl), {
    stdio: [options.inputUrl ? "ignore" : "pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdoutChunks = [];
  const stderrChunks = [];
  child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
  if (input) {
    input.once("error", (error) => child.stdin.destroy(error));
    child.stdin.once("error", () => input.destroy());
    input.pipe(child.stdin);
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killProcess(child);
  }, options.timeoutMs ?? PROBE_TIMEOUT_MS);
  timer.unref?.();
  const result = await waitForProcess(child, stderrChunks, context, "ffprobe");
  clearTimeout(timer);
  input?.destroy();

  if (timedOut) {
    throw new PlaybackError(
      "INSUFFICIENT_TORRENT_DATA",
      "FFprobe timed out while waiting for torrent data.",
      { status: 504 },
    );
  }
  if (result.error || result.code !== 0) {
    throw new PlaybackError(
      "PROBE_FAILED",
      `FFprobe could not inspect this video (exit ${result.code ?? "unavailable"}).`,
      { cause: result.error, status: 502 },
    );
  }
  return parseProbeOutput(Buffer.concat(stdoutChunks).toString("utf8"));
}

export async function findSeekKeyframeOrigin(inputUrl, targetSeconds, options = {}) {
  const target = Math.max(0, Number(targetSeconds) || 0);
  if (!inputUrl || target === 0) return 0;
  const executable = options.ffprobePath ?? resolveFfprobePath();
  const spawnProcess = options.spawnProcess ?? spawn;
  const intervalStart = Math.max(0, target - 120);
  const child = spawnProcess(executable, [
    "-v", "error",
    "-read_intervals", `${intervalStart}%${target + 0.001}`,
    "-select_streams", "v:0",
    "-skip_frame", "nokey",
    "-show_entries", "frame=best_effort_timestamp_time",
    "-of", "json",
    inputUrl,
  ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const stdoutChunks = [];
  const stderrChunks = [];
  child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; killProcess(child); }, options.timeoutMs ?? PROBE_TIMEOUT_MS);
  timer.unref?.();
  const result = await waitForProcess(child, stderrChunks, options.context || "seek keyframe", "ffprobe");
  clearTimeout(timer);
  if (timedOut || result.error || result.code !== 0) {
    throw new PlaybackError("SEEK_PROBE_FAILED", "FFprobe could not locate a safe seek keyframe.", { status: 502 });
  }
  let parsed;
  try { parsed = JSON.parse(Buffer.concat(stdoutChunks).toString("utf8")); } catch {
    throw new PlaybackError("SEEK_PROBE_FAILED", "FFprobe returned invalid seek information.", { status: 502 });
  }
  const times = (Array.isArray(parsed.frames) ? parsed.frames : [])
    .map((frame) => Number(frame.best_effort_timestamp_time))
    .filter((value) => Number.isFinite(value) && value >= 0 && value <= target + 0.001);
  if (!times.length) {
    throw new PlaybackError("SEEK_PROBE_FAILED", "No safe video keyframe was found near the requested position.", { status: 422 });
  }
  return Math.max(...times);
}

async function waitForHlsOutput(job, timeoutMs = HLS_START_TIMEOUT_MS) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (job.state === "failed") throw job.error;
    try {
      const files = await readdir(job.outputDirectory);
      const hasManifest = files.includes("index.m3u8");
      const extension = job.segmentFormat === "fmp4" ? "m4s" : "ts";
      const segmentCount = files.filter(
        (name) => new RegExp(`^segment-\\d{5}\\.${extension}$`).test(name),
      ).length;
      // Start with a short cushion so normal input/transcode jitter does not
      // strand the player at the live edge. Short files may complete sooner.
      if (hasManifest && (segmentCount >= HLS_START_SEGMENTS
        || (job.state === "complete" && segmentCount > 0))) return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new PlaybackError(
    "INSUFFICIENT_TORRENT_DATA",
    "FFmpeg could not produce the first playable segment while waiting for torrent data.",
    { status: 504 },
  );
}

export function createHlsPlaybackJob(file, options = {}) {
  const context = options.context ?? file.name ?? "video";
  const job = {
    id: randomUUID(),
    state: "buffering",
    strategy: null,
    media: null,
    outputDirectory: null,
    error: null,
    stopped: false,
    child: null,
    input: null,
    inputBytesRead: 0,
    inputBytesTotal: file.length,
    originSeconds: Math.max(0, Number(options.startTime) || 0),
    requestedStartSeconds: Math.max(0, Number(options.startTime) || 0),
    startOffsetSeconds: 0,
    audioStreamIndex: Number.isInteger(options.audioStreamIndex) ? options.audioStreamIndex : null,
    plan: options.plan || null,
    planKey: options.plan ? playbackPlanKey(options.plan) : null,
    segmentFormat: options.plan?.segmentFormat || "mpegts",
    lastAccess: Date.now(),
    touch() {
      this.lastAccess = Date.now();
    },
    stop() {
      if (this.stopped) return;
      this.stopped = true;
      this.state = "stopped";
      this.input?.destroy();
      if (this.child) killProcess(this.child);
      const cleanup = () => {
        if (!this.outputDirectory) return;
        void rm(this.outputDirectory, { recursive: true, force: true }).catch((error) => {
          console.error(`[hls] ${context} cleanup failed:`, error);
        });
      };
      if (this.completed) void this.completed.finally(cleanup);
      else cleanup();
    },
  };

  job.ready = (async () => {
    try {
      if (!options.inputUrl) await waitForTorrentBuffer(file, options.prebuffer);
      if (job.stopped) throw new PlaybackError("FFMPEG_FAILED", "Playback preparation was cancelled.");

      job.state = "probing";
      job.media = options.media || await probeVideoFile(file, {
          context,
          inputUrl: options.inputUrl,
          ffprobePath: options.ffprobePath,
          spawnProcess: options.spawnProbe,
          timeoutMs: options.probeTimeoutMs,
        });
      job.strategy = chooseHlsStrategy(job.media, options).name;
      const copyVideo = chooseHlsStrategy(job.media, options).copyVideo;
      if (copyVideo && job.requestedStartSeconds > 0 && options.inputUrl) {
        job.originSeconds = await findSeekKeyframeOrigin(options.inputUrl, job.requestedStartSeconds, {
          context: `${context} seek=${job.requestedStartSeconds}`,
          ffprobePath: options.ffprobePath,
          spawnProcess: options.spawnProbe,
          timeoutMs: options.probeTimeoutMs,
        });
        job.startOffsetSeconds = Math.max(0, job.requestedStartSeconds - job.originSeconds);
      }
      job.outputDirectory = await mkdtemp(path.join(os.tmpdir(), "torplay-hls-"));

      job.state = "starting";
      const executable = resolvePlaybackFfmpegPath(job.media, job.plan, options);
      const spawnProcess = options.spawnFfmpeg ?? spawn;
      if (!options.inputUrl) {
        job.input = createContinuousTorrentStream(file, {
          ...options.torrentRead,
          onProgress: (bytesRead, bytesTotal) => {
            job.inputBytesRead = bytesRead;
            job.inputBytesTotal = bytesTotal;
            options.torrentRead?.onProgress?.(bytesRead, bytesTotal);
          },
        });
      } else {
        job.inputBytesRead = null;
      }
      job.child = spawnProcess(executable, buildFfmpegArgs(job.media, job.outputDirectory, {
        ...options,
        startTime: job.originSeconds,
      }), {
        stdio: [options.inputUrl ? "ignore" : "pipe", "ignore", "pipe"],
        windowsHide: true,
      });
      const stderrChunks = [];
      job.child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
      if (job.input) {
        job.input.once("error", (error) => job.child.stdin.destroy(error));
        job.child.stdin.once("error", () => job.input.destroy());
        job.input.pipe(job.child.stdin);
      }

      job.completed = waitForProcess(job.child, stderrChunks, context, "ffmpeg").then((result) => {
        job.input?.destroy();
        if (job.stopped) return result;
        const playbackError = options.inputUrl
          ? getFfmpegPlaybackError(result, job.inputBytesTotal, job.inputBytesTotal)
          : getFfmpegPlaybackError(result, job.inputBytesRead, job.inputBytesTotal);
        if (playbackError) {
          job.state = "failed";
          job.error = playbackError;
        } else {
          job.state = "complete";
        }
        return result;
      });

      await waitForHlsOutput(job, options.startTimeoutMs);
      if (!job.stopped && job.state !== "complete") job.state = "running";
      return job;
    } catch (error) {
      const playbackError = error instanceof PlaybackError
        ? error
        : new PlaybackError("FFMPEG_FAILED", error.message || "Playback preparation failed.", {
          cause: error,
          status: 502,
        });
      job.error = playbackError;
      if (!job.stopped) job.state = "failed";
      job.input?.destroy();
      if (job.child) killProcess(job.child);
      throw playbackError;
    }
  })();

  return job;
}

export async function extractEmbeddedSubtitle(inputUrl, streamIndex, options = {}) {
  if (!Number.isInteger(streamIndex) || streamIndex < 0) {
    throw new PlaybackError("SUBTITLE_EXTRACTION_FAILED", "Embedded subtitle stream is invalid.", { status: 400 });
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), "torplay-subtitle-"));
  const output = path.join(directory, "subtitle.vtt");
  try {
    const executable = options.ffmpegPath ?? resolveFfmpegPath();
    const spawnProcess = options.spawnProcess ?? spawn;
    const child = spawnProcess(executable, [
      "-y", "-hide_banner", "-loglevel", "error",
      "-i", inputUrl,
      "-map", `0:${streamIndex}`,
      "-f", "webvtt",
      output,
    ], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    const stderrChunks = [];
    child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
    const result = await waitForProcess(child, stderrChunks, options.context || "embedded subtitle", "ffmpeg");
    if (result.error || result.code !== 0) {
      throw new PlaybackError(
        "SUBTITLE_EXTRACTION_FAILED",
        "FFmpeg could not extract this embedded subtitle.",
        { cause: result.error, status: 502 },
      );
    }
    return subtitleToWebVtt(await readFile(output), "vtt");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function hlsAssetExists(job, asset) {
  if (!job?.outputDirectory) return false;
  try {
    await access(path.join(job.outputDirectory, asset));
    return true;
  } catch {
    return false;
  }
}
