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
  resolvePlaybackFfmpegPath,
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
  assert.deepEqual(
    chooseHlsStrategy(
      { videoCodec: "h264", audioCodec: "aac" },
      { startTime: 13.3 },
    ),
    {
      copyVideo: false,
      copyAudio: false,
      name: "transcode",
    },
  );
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
  assert.ok(remux.includes("1.5"));

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
  assert.ok(randomAccess.includes("libx264"));
  assert.ok(randomAccess.includes("aac"));
  assert.equal(randomAccess.includes("copy"), false);

  const selectedTrack = buildFfmpegArgs({
    videoCodec: "h264",
    audioCodec: "aac",
    audioStreams: [
      { index: 2, codec: "aac", language: "en" },
      { index: 5, codec: "ac3", language: "mk" },
    ],
  }, "/tmp/hls-audio-test", { audioStreamIndex: 5 });
  assert.equal(selectedTrack[selectedTrack.indexOf("-map", selectedTrack.indexOf("-map") + 1) + 1], "0:5");
  assert.ok(selectedTrack.includes("aac"));
});

test("parses audio language, layout, and special-track dispositions", () => {
  const media = parseProbeOutput(JSON.stringify({
    format: { format_name: "matroska" },
    streams: [
      { index: 0, codec_type: "video", codec_name: "h264" },
      { index: 2, codec_type: "audio", codec_name: "aac", channels: 2,
        channel_layout: "stereo", tags: { language: "eng", title: "Main" },
        disposition: { default: 1 } },
      { index: 5, codec_type: "audio", codec_name: "ac3", channels: 6,
        tags: { language: "mac", title: "Director Commentary" },
        disposition: { comment: 1 } },
    ],
  }));
  assert.equal(media.audioStreams.length, 2);
  assert.deepEqual(media.audioStreams[0], {
    index: 2, ordinal: 0, codec: "aac", profile: null, language: "en", title: "Main", channels: 2,
    channelLayout: "stereo", sampleRate: null, bitRate: null, atmos: null, atmosEvidence: null,
    default: true, commentary: false, audioDescription: false,
  });
  assert.equal(media.audioStreams[1].language, "mk");
  assert.equal(media.audioStreams[1].commentary, true);
});

test("parses probe output and rejects media without video", () => {
  assert.deepEqual(parseProbeOutput(JSON.stringify({
    format: { format_name: "matroska,webm" },
    streams: [
      { index: 0, codec_type: "video", codec_name: "h264" },
      { index: 1, codec_type: "audio", codec_name: "aac" },
    ],
  })), {
    container: "matroska,webm",
    videoCodec: "h264",
    video: {
      codec: "h264", codecTag: null, profile: null, level: null, width: null, height: null,
      frameRate: null, bitRate: null, pixelFormat: null, bitDepth: null, colorRange: null,
      colorSpace: null, colorTransfer: null, colorPrimaries: null, dolbyVision: null,
      hdrFormat: null, hdr10Plus: false, masteringDisplay: false,
    },
    audioCodec: "aac",
    audioStreams: [{
      index: 1,
      ordinal: 0,
      codec: "aac",
      profile: null,
      language: "und",
      title: null,
      channels: null,
      channelLayout: null,
      sampleRate: null,
      bitRate: null,
      atmos: null,
      atmosEvidence: null,
      default: false,
      commentary: false,
      audioDescription: false,
    }],
    duration: null,
    subtitleStreams: [],
  });
  assert.throws(
    () => parseProbeOutput(JSON.stringify({ streams: [{ codec_type: "audio", codec_name: "aac" }] })),
    (error) => error instanceof PlaybackError && error.code === "UNSUPPORTED_STREAMS",
  );
});

test("normalizes Dolby Vision, HDR, and Atmos probe metadata", () => {
  const media = parseProbeOutput(JSON.stringify({
    format: { format_name: "matroska,webm", duration: "42" },
    streams: [
      { index: 0, codec_type: "video", codec_name: "hevc", codec_tag_string: "dvh1",
        profile: "Main 10", level: 153, width: 3840, height: 2160,
        avg_frame_rate: "24000/1001", pix_fmt: "yuv420p10le", color_primaries: "bt2020",
        color_transfer: "smpte2084", color_space: "bt2020nc", side_data_list: [
          { side_data_type: "DOVI configuration record", dv_profile: 8, dv_level: 6,
            rpu_present_flag: 1, el_present_flag: 0, bl_present_flag: 1,
            dv_bl_signal_compatibility_id: 1 },
          { side_data_type: "HDR Dynamic Metadata SMPTE2094-40 (HDR10+)" },
        ] },
      { index: 3, codec_type: "audio", codec_name: "eac3",
        profile: "Dolby Digital Plus + Dolby Atmos", channels: 6, channel_layout: "5.1(side)",
        sample_rate: "48000", bit_rate: "768000", tags: { language: "eng", title: "Main" },
        disposition: { default: 1 } },
    ],
  }));
  assert.equal(media.videoCodec, "hevc");
  assert.equal(media.video.hdrFormat, "dolby-vision");
  assert.equal(media.video.hdr10Plus, true);
  assert.equal(media.video.bitDepth, 10);
  assert.equal(media.video.dolbyVision.profile, 8);
  assert.equal(media.video.dolbyVision.baseLayerCompatibility, "hdr10");
  assert.equal(media.audioStreams[0].atmos, true);
  assert.equal(media.audioStreams[0].sampleRate, 48000);
  assert.equal(media.audioStreams[0].bitRate, 768000);
});

test("builds fMP4 remux and selective Dolby audio conversion arguments", () => {
  const media = {
    videoCodec: "hevc", video: { dolbyVision: { profile: 8 }, hdrFormat: "dolby-vision" },
    audioCodec: "truehd", audioStreams: [{ index: 2, codec: "truehd", channels: 8 }],
  };
  const args = buildFfmpegArgs(media, "/tmp/dolby-hls", {
    audioStreamIndex: 2,
    plan: { name: "selective-transcode", videoAction: "copy", audioAction: "transcode-eac3",
      segmentFormat: "fmp4" },
  });
  assert.equal(args[args.indexOf("-c:v") + 1], "copy");
  assert.equal(args[args.indexOf("-c:a") + 1], "eac3");
  assert.equal(args[args.indexOf("-tag:v") + 1], "dvh1");
  assert.ok(args.includes("-hls_segment_type"));
  assert.ok(args.some((value) => value.endsWith("segment-%05d.m4s")));
  assert.equal(args.includes("libx264"), false);
});

test("bounds UHD HDR compatibility conversion for real-time playback", () => {
  const media = {
    videoCodec: "hevc",
    video: { width: 3840, height: 2160, hdrFormat: "hdr10", colorTransfer: "smpte2084" },
    audioCodec: "eac3",
    audioStreams: [{ index: 1, codec: "eac3", channels: 6, default: true }],
  };
  const args = buildFfmpegArgs(media, "/tmp/hdr-compatibility", {
    plan: { name: "compatibility-transcode", videoAction: "transcode-h264",
      audioAction: "transcode-aac-stereo", segmentFormat: "mpegts" },
  });

  assert.match(args[args.indexOf("-vf") + 1], /min\(1920,iw\)/);
  assert.equal(args[args.indexOf("-preset") + 1], "superfast");
  assert.equal(args[args.indexOf("-readrate") + 1], "1.5");
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

test("uses bundled FFmpeg when configured FFmpeg lacks HDR tone-mapping filters", () => {
  const selected = resolvePlaybackFfmpegPath({
    video: { hdrFormat: "hdr10", colorTransfer: "smpte2084" },
  }, {
    videoAction: "transcode-h264",
  }, {
    ffmpegPath: "/configured/ffmpeg",
    hasFilter: (executable, filter) => filter === "zscale" && executable !== "/configured/ffmpeg",
  });
  assert.notEqual(selected, "/configured/ffmpeg");
  assert.match(selected, /ffmpeg/i);
});

test("keeps configured FFmpeg for copied HDR and supported tone mapping", () => {
  assert.equal(resolvePlaybackFfmpegPath({
    video: { hdrFormat: "hdr10", colorTransfer: "smpte2084" },
  }, { videoAction: "copy" }, { ffmpegPath: "/configured/ffmpeg", hasFilter: () => false }),
  "/configured/ffmpeg");
  assert.equal(resolvePlaybackFfmpegPath({
    video: { hdrFormat: "hdr10", colorTransfer: "smpte2084" },
  }, { videoAction: "transcode-h264" }, { ffmpegPath: "/configured/ffmpeg", hasFilter: () => true }),
  "/configured/ffmpeg");
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

test("prepares HLS from the explicitly selected language track", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "torplay-multi-audio-test-"));
  const fixture = path.join(directory, "multi-audio.mkv");
  const generated = spawnSync(resolveFfmpegPath(), [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
    "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=44100",
    "-t", "3", "-map", "0:v:0", "-map", "1:a:0", "-map", "2:a:0",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-c:a:0", "aac", "-metadata:s:a:0", "language=eng", "-disposition:a:0", "default",
    "-c:a:1", "ac3", "-metadata:s:a:1", "language=mkd", "-disposition:a:1", "0",
    fixture,
  ], { encoding: "utf8" });
  assert.equal(generated.status, 0, generated.stderr);
  const details = await stat(fixture);
  const file = {
    name: "multi-audio.mkv",
    length: details.size,
    createReadStream: (options) => createReadStream(fixture, options),
  };
  context.after(async () => { await rm(directory, { recursive: true, force: true }); });

  const media = await probeVideoFile(file, { context: "multi-audio fixture" });
  assert.deepEqual(media.audioStreams.map((track) => track.language), ["en", "mk"]);
  const macedonian = media.audioStreams[1];
  const job = createHlsPlaybackJob(file, {
    media,
    audioStreamIndex: macedonian.index,
    context: "selected Macedonian audio",
  });
  context.after(() => job.stop());
  await job.ready;
  assert.equal(job.audioStreamIndex, macedonian.index);
  assert.equal(job.strategy, "transcode");
  assert.ok((await readdir(job.outputDirectory)).includes("index.m3u8"));
});

test("remuxes H.264/AAC from zero and accurately transcodes nonzero seeks", async (context) => {
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
    startTime: 12.3,
    readRate: 100,
    startTimeoutMs: 10_000,
  });
  await seekJob.ready;
  assert.equal(seekJob.originSeconds, 12.3);
  assert.equal(seekJob.strategy, "transcode");
  assert.ok(requestedRanges.some(({ start }) => start > 0));
  assert.ok((await readdir(seekJob.outputDirectory)).some((name) => /^segment-\d{5}\.ts$/.test(name)));
  await seekJob.completed;
  seekJob.stop();

  const copiedSeek = createHlsPlaybackJob(file, {
    context: "test keyframe-aligned copy seek",
    inputUrl: `http://127.0.0.1:${server.address().port}/fixture.mkv`,
    media,
    startTime: 12.3,
    readRate: 100,
    startTimeoutMs: 10_000,
    plan: { name: "remux", delivery: "hls", videoAction: "copy", audioAction: "copy",
      audioStreamIndex: media.audioStreams[0].index, segmentFormat: "mpegts",
      output: { videoCodec: "h264", audioCodec: "aac", hdrFormat: null } },
  });
  context.after(() => copiedSeek.stop());
  await copiedSeek.ready;
  assert.equal(copiedSeek.strategy, "remux");
  assert.ok(copiedSeek.originSeconds <= 12.3);
  assert.ok(copiedSeek.originSeconds >= 10);
  assert.ok(Math.abs(copiedSeek.originSeconds + copiedSeek.startOffsetSeconds - 12.3) < 0.01);
  assert.ok((await readdir(copiedSeek.outputDirectory)).some((name) => /^segment-\d{5}\.ts$/.test(name)));
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

  const remux = createHlsPlaybackJob(file, {
    context: "test HEVC E-AC-3 fMP4 preservation path",
    media: job.media,
    plan: { name: "remux", delivery: "hls", videoAction: "copy", audioAction: "copy",
      audioStreamIndex: job.media.audioStreams[0].index, segmentFormat: "fmp4",
      output: { videoCodec: "hevc", audioCodec: "eac3", hdrFormat: null } },
    audioStreamIndex: job.media.audioStreams[0].index,
    prebuffer: { bytes: details.size, timeoutMs: 5_000 },
    startTimeoutMs: 10_000,
    torrentRead: { chunkBytes: 32 * 1024, stallTimeoutMs: 5_000 },
  });
  context.after(() => remux.stop());
  await remux.ready;
  const remuxFiles = await readdir(remux.outputDirectory);
  assert.ok(remuxFiles.includes("init.mp4"));
  assert.ok(remuxFiles.some((name) => /^segment-\d{5}\.m4s$/.test(name)));
  const preserved = spawnSync(resolveFfprobePath(), [
    "-v", "error", "-show_entries", "stream=codec_type,codec_name", "-of", "json",
    path.join(remux.outputDirectory, "index.m3u8"),
  ], { encoding: "utf8" });
  assert.equal(preserved.status, 0, preserved.stderr);
  const preservedStreams = JSON.parse(preserved.stdout).streams;
  assert.ok(preservedStreams.some((stream) => stream.codec_type === "video" && stream.codec_name === "hevc"));
  assert.ok(preservedStreams.some((stream) => stream.codec_type === "audio" && stream.codec_name === "eac3"));
});
