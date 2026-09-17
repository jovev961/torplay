import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import ffmpegStaticPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import { subtitleToWebVtt } from "./subtitles.js";

const PREBUFFER_BYTES = 16 * 1024 * 1024;
const PREBUFFER_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 60_000;
const HLS_START_TIMEOUT_MS = 120_000;
const FORCE_KILL_DELAY_MS = 2_000;
const HLS_SEGMENT_SECONDS = 4;
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
  const audio = streams.find((stream) => stream.codec_type === "audio");
  if (!video?.codec_name) {
    throw new PlaybackError(
      "UNSUPPORTED_STREAMS",
      "The selected file does not contain a supported video stream.",
      { status: 422 },
    );
  }

  const duration = Number(result.format?.duration || video.duration);
  const textSubtitleCodecs = new Set(["ass", "ssa", "subrip", "text", "webvtt", "mov_text"]);
  return {
    container: result.format?.format_name || "unknown",
    videoCodec: String(video.codec_name).toLowerCase(),
    audioCodec: audio?.codec_name ? String(audio.codec_name).toLowerCase() : null,
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

export function chooseHlsStrategy(media) {
  const copyVideo = media.videoCodec === "h264";
  const copyAudio = !media.audioCodec || media.audioCodec === "aac";
  return {
    copyVideo,
    copyAudio,
    name: copyVideo && copyAudio ? "remux" : "transcode",
  };
}

export function buildFfmpegArgs(media, outputDirectory, options = {}) {
  const strategy = chooseHlsStrategy(media);
  const args = [
    "-hide_banner",
    "-loglevel", "error",
    "-fflags", "+genpts",
    "-readrate", String(options.readRate ?? 1.25),
  ];
  if (Number(options.startTime) > 0) args.push("-ss", String(options.startTime));
  args.push(
    "-i", options.inputUrl || "pipe:0",
    "-map", "0:v:0",
  );
  if (media.audioCodec) args.push("-map", "0:a:0?");
  args.push("-sn", "-dn");

  if (strategy.copyVideo) {
    args.push("-c:v", "copy");
  } else {
    args.push(
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "23",
      "-pix_fmt", "yuv420p",
      "-force_key_frames", `expr:gte(t,n_forced*${HLS_SEGMENT_SECONDS})`,
    );
  }

  if (media.audioCodec) {
    if (strategy.copyAudio) {
      args.push("-c:a", "copy");
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
    "-hls_segment_filename", path.join(outputDirectory, "segment-%05d.ts"),
    path.join(outputDirectory, "index.m3u8"),
  );
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

async function waitForHlsOutput(job, timeoutMs = HLS_START_TIMEOUT_MS) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (job.state === "failed") throw job.error;
    try {
      const files = await readdir(job.outputDirectory);
      const hasManifest = files.includes("index.m3u8");
      const hasSegment = files.some((name) => /^segment-\d{5}\.ts$/.test(name));
      if (hasManifest && hasSegment) return;
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
      job.strategy = chooseHlsStrategy(job.media).name;
      job.outputDirectory = await mkdtemp(path.join(os.tmpdir(), "torplay-hls-"));

      job.state = "starting";
      const executable = options.ffmpegPath ?? resolveFfmpegPath();
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
      job.child = spawnProcess(executable, buildFfmpegArgs(job.media, job.outputDirectory, options), {
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
