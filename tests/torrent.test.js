import assert from "node:assert/strict";
import test from "node:test";
import bencode from "bencode";
import {
  bufferVideoFile,
  cancelVideoFilePrefetch,
  classifyVideoFile,
  DEFAULT_TORRENT_TRACKERS,
  inspectTorrentSource,
  getVideoFilePrefetch,
  listPublicVideoFiles,
  parseTorrentTrackers,
  prefetchVideoFile,
  registerActiveConversion,
  resolveTorrentInput,
  validateTorrentInput,
} from "../lib/torrent/manager.js";

const magnet = "magnet:?xt=urn:btih:0123456789012345678901234567890123456789&dn=TorPlayTest";

function torrentFile() {
  return bencode.encode({
    announce: Buffer.from("http://tracker.test/announce"),
    info: {
      name: Buffer.from("video.mp4"),
      "piece length": 16_384,
      length: 1,
      pieces: Buffer.alloc(20),
    },
  });
}

function torrentPack(files) {
  return bencode.encode({
    announce: Buffer.from("http://tracker.test/announce"),
    info: {
      name: Buffer.from("Show Pack"),
      "piece length": 16_384,
      files: files.map((file) => ({
        length: file.length ?? 1,
        path: file.path.split("/").map((part) => Buffer.from(part)),
      })),
      pieces: Buffer.alloc(20),
    },
  });
}

test("keeps unidentified multi-file show packs available for manual selection", async () => {
  const source = { torrentInput: Buffer.from(torrentPack([
    { path: "OP-1.mkv", length: 1000 },
    { path: "OP-2.mkv", length: 1000 },
  ])) };
  assert.deepEqual(await inspectTorrentSource(source, { type: "show", season: 1, episode: 1 }),
    { playbackMode: null, manualSelectionRequired: true });
});

test("validates a magnet and returns its normalized info hash", async () => {
  const hash = await validateTorrentInput(
    magnet,
  );
  assert.equal(hash, "0123456789012345678901234567890123456789");
});

test("rejects malformed torrent identifiers", async () => {
  await assert.rejects(() => validateTorrentInput("not-a-torrent"), /valid torrent/);
});

test("uses configurable fallback trackers", () => {
  assert.deepEqual(parseTorrentTrackers(""), DEFAULT_TORRENT_TRACKERS);
  assert.deepEqual(parseTorrentTrackers(undefined), DEFAULT_TORRENT_TRACKERS);
  assert.deepEqual(parseTorrentTrackers("none"), []);
  assert.deepEqual(
    parseTorrentTrackers(
      " udp://tracker.test:1337/announce,https://tracker.test/announce,udp://tracker.test:1337/announce ",
    ),
    ["udp://tracker.test:1337/announce", "https://tracker.test/announce"],
  );
  assert.throws(() => parseTorrentTrackers("not-a-url"), /TORRENT_TRACKERS/);
  assert.throws(() => parseTorrentTrackers("ftp://tracker.test/announce"), /unsupported/);
});

test("prefers direct torrent metadata over a magnet", async () => {
  const previousFetch = globalThis.fetch;
  let requestedUrl;
  globalThis.fetch = async (url) => {
    requestedUrl = String(url);
    return new Response(torrentFile(), { status: 200 });
  };

  try {
    const result = await resolveTorrentInput({
      downloadUrl: "https://indexer.test/download",
      magnet,
    });
    assert.equal(requestedUrl, "https://indexer.test/download");
    assert.equal(result.metadataSource, "torrent");
    assert.ok(Buffer.isBuffer(result.input));
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("falls back to a magnet when direct metadata is invalid", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("not a torrent", { status: 200 });

  try {
    const result = await resolveTorrentInput({
      downloadUrl: "https://indexer.test/download",
      magnet,
    });
    assert.equal(result.metadataSource, "magnet");
    assert.equal(result.input, magnet);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("retries direct metadata before falling back to a magnet", async () => {
  const previousFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    return new Response("not a torrent", { status: 200 });
  };

  try {
    const result = await resolveTorrentInput({
      downloadUrl: "https://indexer.test/download",
      magnet,
    });
    assert.equal(result.metadataSource, "magnet");
    assert.equal(result.input, magnet);
    assert.equal(fetches, 1);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("inspects movie metadata and reuses the verified torrent file", async () => {
  const previousFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    return new Response(torrentFile(), { status: 200 });
  };
  const source = { downloadUrl: "https://indexer.test/download", magnet };

  try {
    assert.deepEqual(await inspectTorrentSource(source, { type: "movie" }), {
      playbackMode: "native",
    });
    const resolved = await resolveTorrentInput(source);
    assert.equal(resolved.metadataSource, "torrent");
    assert.equal(fetches, 1);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("resolves provider-owned torrent metadata once and reuses it for playback", async () => {
  let resolutions = 0;
  const source = { resolver: async () => { resolutions += 1; return { torrentInput: Buffer.from(torrentFile()) }; } };
  assert.deepEqual(await inspectTorrentSource(source, { type: "movie" }), { playbackMode: "native" });
  const resolved = await resolveTorrentInput(source);
  assert.equal(resolved.metadataSource, "torrent");
  assert.equal(resolutions, 1);
});

test("prefers provider resolution over a synthesized magnet and reuses the metadata", async () => {
  let resolutions = 0;
  const source = {
    magnet,
    resolver: async () => {
      resolutions += 1;
      return { torrentInput: Buffer.from(torrentFile()) };
    },
  };

  assert.deepEqual(await inspectTorrentSource(source, { type: "movie" }), { playbackMode: "native" });
  const resolved = await resolveTorrentInput(source);
  assert.equal(resolved.metadataSource, "torrent");
  assert.equal(resolutions, 1);
});

test("uses a magnet fallback when provider resolution fails", async () => {
  const source = {
    magnet,
    resolver: async () => { throw new Error("provider unavailable"); },
  };
  const resolved = await resolveTorrentInput(source);
  assert.equal(resolved.metadataSource, "magnet");
  assert.equal(resolved.input, magnet);
});

test("tries provider resolution after direct torrent metadata fails", async () => {
  const previousFetch = globalThis.fetch;
  let resolutions = 0;
  globalThis.fetch = async () => new Response("not a torrent", { status: 200 });
  const source = {
    downloadUrl: "https://indexer.test/download",
    magnet,
    resolver: async () => {
      resolutions += 1;
      return { torrentInput: Buffer.from(torrentFile()) };
    },
  };

  try {
    assert.deepEqual(await inspectTorrentSource(source, { type: "movie" }), { playbackMode: "native" });
    const resolved = await resolveTorrentInput(source);
    assert.equal(resolved.metadataSource, "torrent");
    assert.equal(resolutions, 1);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("verifies a matched show episode and keeps unmatched packs for manual selection", async () => {
  const previousFetch = globalThis.fetch;
  const source = { downloadUrl: "https://indexer.test/show" };
  globalThis.fetch = async () => new Response(torrentPack([
    { path: "Show.S01E01.mkv" },
    { path: "Show.S01E02.mkv" },
    { path: "subtitles.srt" },
  ]), { status: 200 });

  try {
    assert.deepEqual(
      await inspectTorrentSource(source, { type: "show", season: 1, episode: 2 }),
      { playbackMode: "transcode" },
    );
    assert.deepEqual(
      await inspectTorrentSource(
        { downloadUrl: "https://indexer.test/show" },
        { type: "show", season: 1, episode: 3 },
      ),
      { playbackMode: null, manualSelectionRequired: true },
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("rejects metadata without a recognized video and magnet-only sources", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(torrentPack([
    { path: "readme.txt" },
    { path: "subtitles.srt" },
  ]), { status: 200 });

  try {
    assert.equal(
      await inspectTorrentSource({ downloadUrl: "https://indexer.test/files" }, { type: "movie" }),
      null,
    );
    assert.equal(await inspectTorrentSource({ magnet }, { type: "movie" }), null);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("reference-counts selected file pieces across playback sessions", () => {
  const calls = [];
  const first = {
    name: "Show.S01E01.mp4",
    path: "Show/Show.S01E01.mp4",
    offset: 0,
    length: 24,
  };
  const second = {
    name: "Show.S01E02.mp4",
    path: "Show/Show.S01E02.mp4",
    offset: 24,
    length: 24,
  };
  const resource = {
    torrent: {
      files: [first, second],
      pieceLength: 16,
      select: (start, end, priority) => calls.push(["select", start, end, priority]),
      deselect: (start, end) => calls.push(["deselect", start, end]),
    },
    pieceRefs: new Map(),
  };
  const firstSession = { resource, selectedFileId: null, activeConversion: null, lastActivity: 0 };
  const secondSession = { resource, selectedFileId: null, activeConversion: null, lastActivity: 0 };

  bufferVideoFile(firstSession, first);
  bufferVideoFile(secondSession, second);
  bufferVideoFile(firstSession, second);

  assert.deepEqual(calls, [
    ["select", 0, 1, 0],
    ["select", 2, 2, 0],
    ["deselect", 0, 0],
  ]);
  assert.deepEqual([...resource.pieceRefs], [[1, 2], [2, 2]]);
  assert.equal(firstSession.selectedFileId, "1");
  assert.equal(secondSession.selectedFileId, "1");
});

test("a distant seek replaces only that viewer's buffer-ahead lease", () => {
  const calls = [];
  const file = { name: "episode.mkv", path: "Show/episode.mkv", offset: 0, length: 1_000_000_000 };
  const resource = {
    torrent: {
      files: [file],
      pieceLength: 1_000_000,
      select: (start, end) => calls.push(["select", start, end]),
      deselect: (start, end) => calls.push(["deselect", start, end]),
    },
    pieceRefs: new Map(),
  };
  const viewer = { resource, selectedFileId: null, priorityLease: null, activeConversion: null };
  const otherViewer = { resource, selectedFileId: null, priorityLease: null, activeConversion: null };

  bufferVideoFile(viewer, file, { start: 0, end: 9_999_999 });
  bufferVideoFile(otherViewer, file, { start: 700_000_000, end: 709_999_999 });
  bufferVideoFile(viewer, file, { start: 500_000_000, end: 509_999_999 });

  assert.deepEqual(calls, [
    ["select", 0, 9],
    ["select", 700, 709],
    ["deselect", 0, 9],
    ["select", 500, 509],
  ]);
  for (let piece = 700; piece <= 709; piece += 1) {
    assert.equal(resource.pieceRefs.get(piece), 1);
  }
  assert.equal(resource.pieceRefs.has(10), false);
  assert.equal(resource.pieceRefs.has(499), false);
});

test("keeps next-episode prefetch separate from the active episode lease", () => {
  const calls = [];
  const completed = new Set();
  const first = { name: "Show.S01E01.mp4", offset: 0, length: 48 };
  const second = { name: "Show.S01E02.mp4", offset: 48, length: 48 };
  const third = { name: "Show.S01E03.mp4", offset: 96, length: 48 };
  const resource = {
    torrent: {
      files: [first, second, third],
      pieceLength: 16,
      bitfield: { get: (piece) => completed.has(piece) },
      select: (start, end, priority) => calls.push(["select", start, end, priority]),
      deselect: (start, end) => calls.push(["deselect", start, end]),
    },
    pieceRefs: new Map(),
  };
  const session = { resource, selectedFileId: null, priorityLease: null,
    prefetch: null, activeConversion: null, lastActivity: 0 };

  bufferVideoFile(session, first, { start: 0, end: 31 });
  const preparing = prefetchVideoFile(session, second, 32);

  assert.equal(preparing.state, "preparing");
  assert.deepEqual([...resource.pieceRefs], [[0, 1], [1, 1], [3, 1], [4, 1]]);
  assert.equal(resource.pieceRefs.has(6), false);
  assert.equal(resource.pieceRefs.has(7), false);
  assert.equal(resource.pieceRefs.has(8), false);

  completed.add(3);
  completed.add(4);
  assert.deepEqual(getVideoFilePrefetch(session), {
    state: "ready", fileId: "1", targetBytes: 32, downloadedBytes: 32,
  });

  bufferVideoFile(session, second, { start: 0, end: 15 });
  assert.equal(session.prefetch, null);
  assert.equal(resource.pieceRefs.get(3), 1);
  assert.equal(resource.pieceRefs.has(4), false);
  assert.equal(calls.some(([operation, start, end]) =>
    operation === "deselect" && start <= 3 && end >= 3), false);
});

test("replaces and cancels a bounded next-episode prefetch lease", () => {
  const calls = [];
  const first = { name: "Show.S01E01.mp4", offset: 0, length: 64 };
  const second = { name: "Show.S01E02.mp4", offset: 64, length: 64 };
  const resource = {
    torrent: {
      files: [first, second], pieceLength: 16,
      bitfield: { get: () => false },
      select: (start, end) => calls.push(["select", start, end]),
      deselect: (start, end) => calls.push(["deselect", start, end]),
    },
    pieceRefs: new Map(),
  };
  const session = { resource, selectedFileId: null, priorityLease: null,
    prefetch: null, activeConversion: null, lastActivity: 0 };

  prefetchVideoFile(session, second, 16);
  prefetchVideoFile(session, second, 48);
  assert.deepEqual([...resource.pieceRefs], [[4, 1], [5, 1], [6, 1]]);
  assert.equal(cancelVideoFilePrefetch(session, first), false);
  assert.equal(cancelVideoFilePrefetch(session, second), true);
  assert.deepEqual([...resource.pieceRefs], []);
  assert.deepEqual(getVideoFilePrefetch(session), { state: "idle" });
});

test("keeps original torrent indexes and safe relative paths in public files", () => {
  const files = [
    { name: "readme.txt", path: "Show/readme.txt", length: 3, downloaded: 0 },
    { name: "video.mp4", path: "Show/Season 01/Episode 01/video.mp4", length: 20, downloaded: 5 },
    { name: "cover.jpg", path: "Show/cover.jpg", length: 4, downloaded: 0 },
    { name: "video.mp4", path: "Show/Season 01/Episode 02/video.mp4", length: 30, downloaded: 0 },
  ];
  const session = {
    id: "session",
    selectedFileId: "3",
    resource: { torrent: { files } },
  };

  assert.deepEqual(
    listPublicVideoFiles(session).map(({ id, name, relativePath, buffering }) => ({
      id,
      name,
      relativePath,
      buffering,
    })),
    [
      {
        id: "1",
        name: "video.mp4",
        relativePath: "Show/Season 01/Episode 01/video.mp4",
        buffering: false,
      },
      {
        id: "3",
        name: "video.mp4",
        relativePath: "Show/Season 01/Episode 02/video.mp4",
        buffering: true,
      },
    ],
  );
});

test("classifies native and converted video containers", () => {
  assert.deepEqual(classifyVideoFile("movie.MP4"), {
    mimeType: "video/mp4",
    sourceMimeType: "video/mp4",
    playbackMode: "native",
  });
  assert.deepEqual(classifyVideoFile("episode.mkv"), {
    mimeType: "video/mp4",
    sourceMimeType: "video/x-matroska",
    playbackMode: "transcode",
  });
  for (const [extension, sourceMimeType] of Object.entries({
    "3g2": "video/3gpp2", "3gp": "video/3gpp", divx: "video/x-msvideo",
    mpeg: "video/mpeg", mpg: "video/mpeg", mts: "video/mp2t",
    ogm: "video/ogg", ogv: "video/ogg", vob: "video/mpeg",
  })) {
    assert.deepEqual(classifyVideoFile(`legacy.${extension}`), {
      mimeType: "video/mp4",
      sourceMimeType,
      playbackMode: "transcode",
    });
  }
  assert.equal(classifyVideoFile("subtitles.srt"), null);
});

test("keeps only one active conversion per torrent session", () => {
  const calls = [];
  const session = { activeConversion: null };
  const firstFile = { name: "first.mkv" };
  const secondFile = { name: "second.mkv" };
  const releaseFirst = registerActiveConversion(session, firstFile, () => calls.push("stop-first"));
  const releaseSecond = registerActiveConversion(session, secondFile, () => calls.push("stop-second"));

  releaseFirst();
  assert.equal(session.activeConversion?.file, secondFile);
  releaseSecond();
  assert.equal(session.activeConversion, null);
  assert.deepEqual(calls, ["stop-first"]);
});

test("keeps the live playback job instead of a stale snapshot", () => {
  const session = { activeConversion: null, lastActivity: 0 };
  const file = { name: "episode.mkv" };
  const job = { state: "buffering", outputDirectory: null, stop() {} };

  registerActiveConversion(session, file, job);
  job.state = "running";
  job.outputDirectory = "/tmp/live-hls";

  assert.equal(session.activeConversion, job);
  assert.equal(session.activeConversion.state, "running");
  assert.equal(session.activeConversion.outputDirectory, "/tmp/live-hls");
  assert.equal(session.activeConversion.file, file);
});
