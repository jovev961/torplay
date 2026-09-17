import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { createReadStream, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";
import {
  buildFfmpegArgs,
  chooseHlsStrategy,
  createContinuousTorrentStream,
  createHlsPlaybackJob,
  getFfmpegPlaybackError,
  parseProbeOutput,
  PlaybackError,
  probeVideoFile,
  resolveFfmpegPath,
  resolveFfprobePath,
  waitForTorrentBuffer,
} from "../lib/video/transcode.js";

test("chooses remux and transcode strategies from probed codecs", () => {
  assert.deepEqual(chooseHlsStrategy({ videoCodec: "h264", audioCodec: "aac" }), {
    copyVideo: true,
    copyAudio: true,
    name: "remux",
  });
  assert.deepEqual(chooseHlsStrategy({ videoCodec: "h264", audioCodec: "ac3" }), {
    copyVideo: true,
    copyAudio: false,
    name: "transcode",
  });
  assert.deepEqual(chooseHlsStrategy({ videoCodec: "hevc", audioCodec: "aac" }), {
    copyVideo: false,
    copyAudio: true,
    name: "transcode",
  });
});

test("builds HLS stream-copy and H.264/AAC conversion arguments", () => {
  const remux = buildFfmpegArgs(
    { videoCodec: "h264", audioCodec: "aac" },
    "/tmp/hls-test",
  );
  assert.ok(remux.includes("copy"));
  assert.equal(remux.includes("libx264"), false);
  assert.ok(remux.includes("hls"));
  assert.ok(remux.includes("event"));
  assert.ok(remux.includes("1.25"));

  const transcode = buildFfmpegArgs(
    { videoCodec: "hevc", audioCodec: "ac3" },
    "/tmp/hls-test",
  );
  assert.ok(transcode.includes("libx264"));
  assert.ok(transcode.includes("aac"));
  assert.ok(transcode.includes("independent_segments+temp_file"));

  const randomAccess = buildFfmpegArgs(
    { videoCodec: "h264", audioCodec: "aac" },
    "/tmp/hls-seek-test",
    { inputUrl: "http://127.0.0.1:1234/file", startTime: 1_800 },
  );
  assert.equal(randomAccess[randomAccess.indexOf("-ss") + 1], "1800");
  assert.ok(randomAccess.indexOf("-ss") < randomAccess.indexOf("-i"));
  assert.equal(randomAccess[randomAccess.indexOf("-i") + 1], "http://127.0.0.1:1234/file");
  assert.equal(randomAccess.includes("pipe:0"), false);
});

test("parses probe output and rejects media without video", () => {
  assert.deepEqual(parseProbeOutput(JSON.stringify({
    format: { format_name: "matroska,webm" },
    streams: [
      { codec_type: "video", codec_name: "h264" },
      { codec_type: "audio", codec_name: "aac" },
    ],
  })), {
    container: "matroska,webm",
    videoCodec: "h264",
    audioCodec: "aac",
    duration: null,
    subtitleStreams: [],
  });
  assert.throws(
    () => parseProbeOutput(JSON.stringify({ streams: [{ codec_type: "audio", codec_name: "aac" }] })),
    (error) => error instanceof PlaybackError && error.code === "UNSUPPORTED_STREAMS",
  );
});

test("prebuffers a contiguous prefix and reports incomplete torrent data", async () => {
  const success = await waitForTorrentBuffer({
    length: 6,
    createReadStream: () => Readable.from([Buffer.from("abc"), Buffer.from("def")]),
  }, { bytes: 4, timeoutMs: 100 });
  assert.deepEqual(success, { bytes: 6, target: 4 });

  await assert.rejects(
    waitForTorrentBuffer({
      length: 8,
      createReadStream: () => Readable.from(Buffer.from("abc")),
    }, { bytes: 8, timeoutMs: 100 }),
    (error) => error.code === "INSUFFICIENT_TORRENT_DATA",
  );
});

test("continuous torrent input resumes after a range ends early", async () => {
  const source = Buffer.from("abcdefghijklmnopqrstuvwxyz");
  const ranges = [];
  let shortenedFirstRange = false;
  const file = {
    length: source.length,
    createReadStream: ({ start, end }) => {
      ranges.push({ start, end });
      if (start === 0 && !shortenedFirstRange) {
        shortenedFirstRange = true;
        return Readable.from(source.subarray(0, 3));
      }
      return Readable.from(source.subarray(start, end + 1));
    },
  };

  const chunks = [];
  for await (const chunk of createContinuousTorrentStream(file, {
    chunkBytes: 8,
    retryDelayMs: 1,
    stallTimeoutMs: 100,
  })) {
    chunks.push(chunk);
  }

  assert.deepEqual(Buffer.concat(chunks), source);
  assert.deepEqual(ranges.slice(0, 3), [
    { start: 0, end: 7 },
    { start: 3, end: 10 },
    { start: 11, end: 18 },
  ]);
});

test("treats incomplete input and premature-file warnings as playback failures", () => {
  const incomplete = getFfmpegPlaybackError(
    { code: 0, signal: null, error: null, stderr: "File ended prematurely" },
    40,
    100,
  );
  assert.equal(incomplete.code, "INSUFFICIENT_TORRENT_DATA");

  const corrupt = getFfmpegPlaybackError(
    { code: 0, signal: null, error: null, stderr: "File ended prematurely" },
    100,
    100,
  );
  assert.equal(corrupt.code, "FFMPEG_FAILED");
  assert.equal(getFfmpegPlaybackError(
    { code: 0, signal: null, error: null, stderr: "" },
    100,
    100,
  ), null);
});

test("resolves bundled FFmpeg and FFprobe executables", () => {
  assert.match(resolveFfmpegPath(), /ffmpeg/i);
  assert.match(resolveFfprobePath(), /ffprobe/i);
});

test("probe failures log complete stderr and expose the exit code", async () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.killed = false;
  child.kill = () => true;
  const first = "begin-".padEnd(2_500, "a");
  const last = "-end-of-full-stderr";
  const logs = [];
  const previousConsoleError = console.error;
  console.error = (...values) => logs.push(values.join(" "));

  try {
    const probing = probeVideoFile(
      {
        name: "broken.mkv",
        createReadStream: () => Readable.from(Buffer.from("invalid media")),
      },
      {
        ffprobePath: "/test/ffprobe",
        spawnProcess: () => child,
        timeoutMs: 1_000,
        context: "broken fixture",
      },
    );
    queueMicrotask(() => {
      child.stderr.end(`${first}${last}`);
      child.exitCode = 9;
      child.emit("close", 9, null);
    });

    await assert.rejects(
      probing,
      (error) => error.code === "PROBE_FAILED" && error.message.includes("exit 9"),
    );
    assert.ok(logs.some((line) => line.includes(first) && line.includes(last)));
  } finally {
    console.error = previousConsoleError;
  }
});

test("probes and remuxes an H.264/AAC MKV into playable HLS", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "torplay-test-"));
  const fixture = path.join(directory, "fixture.mkv");
  const generated = spawnSync(resolveFfmpegPath(), [
    "-y",
    "-hide_banner",
    "-loglevel", "error",
    "-f", "lavfi",
    "-i", "testsrc2=size=640x360:rate=24",
    "-f", "lavfi",
    "-i", "sine=frequency=1000:sample_rate=44100",
    "-t", "20",
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-crf", "18",
    "-g", "48",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-f", "matroska",
    fixture,
  ], { encoding: "utf8" });
  assert.equal(generated.status, 0, generated.stderr);
  const details = await stat(fixture);
  const file = {
    name: "fixture.mkv",
    length: details.size,
    createReadStream: (options) => createReadStream(fixture, options),
  };

  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const media = await probeVideoFile(file, { context: "test fixture" });
  assert.equal(media.container, "matroska,webm");
  assert.equal(media.videoCodec, "h264");
  assert.equal(media.audioCodec, "aac");

  const job = createHlsPlaybackJob(file, {
    context: "test MKV HLS path",
    prebuffer: { bytes: Math.min(details.size, 64 * 1024), timeoutMs: 5_000 },
    probeTimeoutMs: 5_000,
    startTimeoutMs: 10_000,
    readRate: 100,
  });
  await job.ready;
  assert.equal(job.strategy, "remux");
  const files = await readdir(job.outputDirectory);
  assert.ok(files.includes("index.m3u8"));
  const segment = files.find((name) => /^segment-\d{5}\.ts$/.test(name));
  assert.ok(segment);
  assert.match(readFileSync(path.join(job.outputDirectory, "index.m3u8"), "utf8"), /#EXTM3U/);
  const verifiedSegment = spawnSync(resolveFfprobePath(), [
    "-v", "error",
    "-show_entries", "stream=codec_type,codec_name",
    "-of", "json",
    path.join(job.outputDirectory, segment),
  ], { encoding: "utf8" });
  assert.equal(verifiedSegment.status, 0, verifiedSegment.stderr);
  const segmentStreams = JSON.parse(verifiedSegment.stdout).streams;
  assert.ok(segmentStreams.some((stream) => stream.codec_type === "video" && stream.codec_name === "h264"));
  assert.ok(segmentStreams.some((stream) => stream.codec_type === "audio" && stream.codec_name === "aac"));
  await job.completed;
  job.stop();

  const requestedRanges = [];
  const server = createServer((request, response) => {
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || "");
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Number(range[2]) : details.size - 1;
    requestedRanges.push({ start, end });
    const headers = {
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
      "Content-Type": "video/x-matroska",
    };
    if (range) headers["Content-Range"] = `bytes ${start}-${end}/${details.size}`;
    response.writeHead(range ? 206 : 200, headers);
    createReadStream(fixture, { start, end }).pipe(response);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));

  const seekJob = createHlsPlaybackJob(file, {
    context: "test random-access MKV HLS path",
    inputUrl: `http://127.0.0.1:${server.address().port}/fixture.mkv`,
    media,
    startTime: 12,
    readRate: 100,
    startTimeoutMs: 10_000,
  });
  await seekJob.ready;
  assert.equal(seekJob.originSeconds, 12);
  assert.ok(requestedRanges.some(({ start }) => start > 0));
  assert.ok((await readdir(seekJob.outputDirectory)).some((name) => /^segment-\d{5}\.ts$/.test(name)));
  await seekJob.completed;
  seekJob.stop();
});

test("transcodes an HEVC/E-AC-3 MKV into H.264/AAC HLS", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "torplay-hevc-test-"));
  const fixture = path.join(directory, "fixture-hevc.mkv");
  const generated = spawnSync(resolveFfmpegPath(), [
    "-y",
    "-hide_banner",
    "-loglevel", "error",
    "-f", "lavfi",
    "-i", "testsrc=size=160x90:rate=24",
    "-f", "lavfi",
    "-i", "sine=frequency=800:sample_rate=44100",
    "-t", "1",
    "-c:v", "libx265",
    "-pix_fmt", "yuv420p",
    "-c:a", "eac3",
    "-f", "matroska",
    fixture,
  ], { encoding: "utf8" });
  assert.equal(generated.status, 0, generated.stderr);
  const details = await stat(fixture);
  const file = {
    name: "fixture-hevc.mkv",
    length: details.size,
    createReadStream: (options) => createReadStream(fixture, options),
  };
  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const job = createHlsPlaybackJob(file, {
    context: "test HEVC E-AC-3 path",
    prebuffer: { bytes: details.size, timeoutMs: 5_000 },
    probeTimeoutMs: 5_000,
    startTimeoutMs: 10_000,
    torrentRead: { chunkBytes: 32 * 1024, stallTimeoutMs: 5_000 },
  });
  await job.ready;
  assert.equal(job.strategy, "transcode");
  assert.equal(job.media.videoCodec, "hevc");
  assert.equal(job.media.audioCodec, "eac3");

  const files = await readdir(job.outputDirectory);
  const segment = files.find((name) => /^segment-\d{5}\.ts$/.test(name));
  assert.ok(segment);
  const verified = spawnSync(resolveFfprobePath(), [
    "-v", "error",
    "-show_entries", "stream=codec_type,codec_name",
    "-of", "json",
    path.join(job.outputDirectory, segment),
  ], { encoding: "utf8" });
  assert.equal(verified.status, 0, verified.stderr);
  const streams = JSON.parse(verified.stdout).streams;
  assert.ok(streams.some((stream) => stream.codec_type === "video" && stream.codec_name === "h264"));
  assert.ok(streams.some((stream) => stream.codec_type === "audio" && stream.codec_name === "aac"));
  job.stop();
});
