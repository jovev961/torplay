import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebTorrent from "webtorrent";
import { streamVideoFile } from "../app/api/torrents/[id]/files/[fileId]/stream/route.js";
import {
  bufferVideoFile,
  getActiveConversion,
  listPublicVideoFiles,
  registerActiveConversion,
} from "../lib/torrent/manager.js";
import { findEpisodeFile } from "../lib/video/episode.js";

function bytes(length, multiplier, offset = 0) {
  return Buffer.from(Array.from({ length }, (_, index) => (index * multiplier + offset) % 256));
}

function seed(client, input, options) {
  return new Promise((resolve, reject) => {
    const torrent = client.seed(input, options, resolve);
    torrent.once("error", reject);
  });
}

function destroyClient(client) {
  return new Promise((resolve) => client.destroy(resolve));
}

function filePieces(torrent, file) {
  const start = Math.floor(file.offset / torrent.pieceLength);
  const end = Math.floor((file.offset + file.length - 1) / torrent.pieceLength);
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

function playbackSession(resource, id) {
  return {
    id,
    resource,
    selectedFileId: null,
    activeConversion: null,
    streams: 0,
    lastActivity: 0,
  };
}

async function rangeBytes(session, file, start, end) {
  const response = await streamVideoFile(
    new Request("http://localhost/video", {
      headers: { Range: `bytes=${start}-${end}` },
    }),
    { session, file, mimeType: "video/mp4", playbackMode: "native" },
  );
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), `bytes ${start}-${end}/${file.length}`);
  assert.equal(response.headers.get("content-length"), String(end - start + 1));
  return Buffer.from(await response.arrayBuffer());
}

test("streams independent files from a realistic shared-piece season torrent", {
  timeout: 15_000,
}, async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "torplay-season-pack-"));
  const firstDirectory = path.join(root, "Season 01", "Episode 01");
  const secondDirectory = path.join(root, "Season 01", "Episode 02");
  const thirdDirectory = path.join(root, "Season 01", "Episode 03");
  await Promise.all([
    mkdir(firstDirectory, { recursive: true }),
    mkdir(secondDirectory, { recursive: true }),
    mkdir(thirdDirectory, { recursive: true }),
  ]);

  const firstBytes = bytes(20_000, 3, 1);
  const secondBytes = bytes(18_000, 5, 7);
  const thirdBytes = bytes(9_000, 11, 13);
  await Promise.all([
    writeFile(path.join(root, "README.txt"), bytes(257, 1)),
    writeFile(path.join(firstDirectory, "video.mp4"), firstBytes),
    writeFile(path.join(secondDirectory, "video.mp4"), secondBytes),
    writeFile(path.join(thirdDirectory, "video.mp4"), thirdBytes),
  ]);

  const client = new WebTorrent({
    dht: false,
    tracker: false,
    lsd: false,
    natUpnp: false,
    natPmp: false,
    utp: false,
  });
  context.after(async () => {
    await destroyClient(client);
    await rm(root, { recursive: true, force: true });
  });

  const torrent = await seed(client, root, {
    pieceLength: 16 * 1024,
    announceList: [],
  });
  const resource = { torrent, pieceRefs: new Map() };
  const firstSession = playbackSession(resource, "viewer-one");
  const secondSession = playbackSession(resource, "viewer-two");
  const publicFiles = listPublicVideoFiles(firstSession);
  const firstPublic = findEpisodeFile(publicFiles, 1, 1);
  const secondPublic = findEpisodeFile(publicFiles, 1, 2);
  const thirdPublic = findEpisodeFile(publicFiles, 1, 3);

  assert.ok(firstPublic);
  assert.ok(secondPublic);
  assert.ok(thirdPublic);
  assert.equal(firstPublic.name, "video.mp4");
  assert.equal(secondPublic.name, "video.mp4");
  assert.notEqual(firstPublic.relativePath, secondPublic.relativePath);

  const firstFile = torrent.files[Number(firstPublic.id)];
  const secondFile = torrent.files[Number(secondPublic.id)];
  const thirdFile = torrent.files[Number(thirdPublic.id)];
  assert.equal(String(torrent.files.indexOf(firstFile)), firstPublic.id);
  assert.equal(String(torrent.files.indexOf(secondFile)), secondPublic.id);
  assert.equal(String(torrent.files.indexOf(thirdFile)), thirdPublic.id);
  assert.equal(firstFile._endPiece, secondFile._startPiece);

  const selectionCalls = [];
  const select = torrent.select.bind(torrent);
  const deselect = torrent.deselect.bind(torrent);
  torrent.select = (start, end, priority) => {
    selectionCalls.push(["select", start, end, priority]);
    return select(start, end, priority);
  };
  torrent.deselect = (start, end) => {
    selectionCalls.push(["deselect", start, end]);
    return deselect(start, end);
  };

  bufferVideoFile(firstSession, firstFile);
  bufferVideoFile(secondSession, secondFile);
  const expectedSelected = new Set([
    ...filePieces(torrent, firstFile),
    ...filePieces(torrent, secondFile),
  ]);
  assert.deepEqual([...resource.pieceRefs.keys()].sort((a, b) => a - b), [...expectedSelected].sort((a, b) => a - b));
  for (const piece of filePieces(torrent, thirdFile)) {
    if (!expectedSelected.has(piece)) assert.equal(resource.pieceRefs.has(piece), false);
  }
  assert.ok(selectionCalls.some(([operation]) => operation === "select"));

  assert.deepEqual(await rangeBytes(firstSession, firstFile, 31, 94), firstBytes.subarray(31, 95));
  assert.deepEqual(await rangeBytes(firstSession, firstFile, firstFile.length - 16, firstFile.length - 1), firstBytes.subarray(-16));
  assert.deepEqual(await rangeBytes(secondSession, secondFile, 0, 15), secondBytes.subarray(0, 16));

  const stopped = [];
  const firstJob = { stop: () => stopped.push("viewer-one") };
  const secondJob = { stop: () => stopped.push("viewer-two") };
  registerActiveConversion(firstSession, firstFile, firstJob);
  registerActiveConversion(secondSession, secondFile, secondJob);
  const callsBeforeSwitch = selectionCalls.length;
  bufferVideoFile(firstSession, thirdFile);

  assert.deepEqual(stopped, ["viewer-one"]);
  assert.equal(getActiveConversion(secondSession, secondFile), secondJob);
  assert.equal(secondSession.selectedFileId, secondPublic.id);
  assert.equal(firstSession.selectedFileId, thirdPublic.id);
  const switchCalls = selectionCalls.slice(callsBeforeSwitch);
  assert.equal(switchCalls.some(([operation, start, end]) =>
    operation === "deselect" && start <= firstFile._endPiece && end >= firstFile._endPiece
  ), false);
  for (const piece of filePieces(torrent, firstFile)) {
    const stillNeeded = filePieces(torrent, secondFile).includes(piece)
      || filePieces(torrent, thirdFile).includes(piece);
    if (!stillNeeded) assert.equal(resource.pieceRefs.has(piece), false);
  }
  for (const piece of filePieces(torrent, secondFile)) {
    assert.ok((resource.pieceRefs.get(piece) || 0) > 0);
  }
});
