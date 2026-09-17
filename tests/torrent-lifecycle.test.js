import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DELETE as deleteSession } from "../app/api/torrents/[id]/route.js";
import { POST as releaseSession } from "../app/api/torrents/[id]/release/route.js";
import { releaseTorrentSession } from "../components/useSourceLookup.js";
import {
  cleanupIdleTorrentSessions,
  stopTorrent,
  TORRENT_SESSION_IDLE_TTL_MS,
} from "../lib/torrent/manager.js";

const stateKey = Symbol.for("torplay.torrentState");

function createState(sessions = [], resources = [], remove = async () => {}) {
  return {
    client: { remove },
    sessions: new Map(sessions.map((session) => [session.id, session])),
    resources: new Map(resources.map((resource) => [resource.infoHash, resource])),
    resourceStarts: new Map(),
    mediaServer: null,
    mediaServerReady: null,
    storageReady: Promise.resolve(),
    cleanupTimer: null,
  };
}

function createResource(infoHash) {
  return {
    infoHash,
    torrent: { infoHash, destroyed: false, files: [] },
    sessions: new Set(),
    pieceRefs: new Map(),
    mediaProbes: new Map(),
    metadataTimer: null,
  };
}

function createSession(id, resource, overrides = {}) {
  resource.sessions.add(id);
  return {
    id,
    resource,
    streams: 0,
    lastActivity: Date.now(),
    selectedFileId: null,
    priorityLease: null,
    activeConversion: null,
    ...overrides,
  };
}

async function withTemporaryTorrentState(run) {
  const previousState = globalThis[stateKey];
  const previousPath = process.env.TORRENT_DOWNLOAD_PATH;
  const root = await mkdtemp(path.join(os.tmpdir(), "torplay-lifecycle-"));
  process.env.TORRENT_DOWNLOAD_PATH = root;
  try {
    await run(root);
  } finally {
    if (previousState === undefined) delete globalThis[stateKey];
    else globalThis[stateKey] = previousState;
    if (previousPath === undefined) delete process.env.TORRENT_DOWNLOAD_PATH;
    else process.env.TORRENT_DOWNLOAD_PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
}

test("keeps a shared torrent until its final viewer leaves, then deletes its files", async () => {
  await withTemporaryTorrentState(async (root) => {
    const infoHash = "0123456789012345678901234567890123456789";
    const directory = path.join(root, infoHash);
    await mkdir(directory);
    await writeFile(path.join(directory, "movie.mp4"), "temporary video data");

    const resource = createResource(infoHash);
    let stoppedConversions = 0;
    const first = createSession("first", resource);
    const second = createSession("second", resource, {
      activeConversion: { stop: () => { stoppedConversions += 1; } },
    });
    const removeCalls = [];
    globalThis[stateKey] = createState(
      [first, second],
      [resource],
      async (...args) => { removeCalls.push(args); },
    );

    assert.equal(await stopTorrent(first.id), true);
    await access(directory);
    assert.equal(removeCalls.length, 0);

    assert.equal(await stopTorrent(second.id), true);
    await assert.rejects(access(directory));
    assert.deepEqual(removeCalls, [[infoHash, { destroyStore: true }]]);
    assert.equal(stoppedConversions, 1);
  });
});

test("expires abandoned sessions after two minutes but keeps recent and streaming sessions", async () => {
  await withTemporaryTorrentState(async () => {
    const now = 1_000_000;
    const expiredResource = createResource("1111111111111111111111111111111111111111");
    const recentResource = createResource("2222222222222222222222222222222222222222");
    const streamingResource = createResource("3333333333333333333333333333333333333333");
    const expired = createSession("expired", expiredResource, {
      lastActivity: now - TORRENT_SESSION_IDLE_TTL_MS - 1,
    });
    const recent = createSession("recent", recentResource, {
      lastActivity: now - TORRENT_SESSION_IDLE_TTL_MS + 1,
    });
    const streaming = createSession("streaming", streamingResource, {
      lastActivity: now - TORRENT_SESSION_IDLE_TTL_MS - 1,
      streams: 1,
    });
    globalThis[stateKey] = createState(
      [expired, recent, streaming],
      [expiredResource, recentResource, streamingResource],
    );

    assert.equal(TORRENT_SESSION_IDLE_TTL_MS, 120_000);
    assert.equal(await cleanupIdleTorrentSessions(now), 1);
    assert.equal(globalThis[stateKey].sessions.has("expired"), false);
    assert.equal(globalThis[stateKey].sessions.has("recent"), true);
    assert.equal(globalThis[stateKey].sessions.has("streaming"), true);
  });
});

test("session release endpoints are idempotent", async () => {
  await withTemporaryTorrentState(async () => {
    globalThis[stateKey] = createState();
    const context = { params: Promise.resolve({ id: "already-removed" }) };

    assert.equal((await releaseSession(new Request("http://localhost/release"), context)).status, 204);
    assert.equal((await deleteSession(new Request("http://localhost/session"), context)).status, 204);
  });
});

test("uses a beacon for page exit and keepalive requests for fallback or explicit cleanup", async () => {
  const calls = [];
  const beaconUrls = [];
  const fetchImpl = async (url, options) => {
    calls.push([url, options]);
    return new Response(null, { status: 204 });
  };

  assert.equal(await releaseTorrentSession("a/b", {
    fetchImpl,
    navigatorImpl: { sendBeacon: (url) => { beaconUrls.push(url); return true; } },
    preferBeacon: true,
  }), true);
  assert.deepEqual(beaconUrls, ["/api/torrents/a%2Fb/release"]);
  assert.equal(calls.length, 0);

  await releaseTorrentSession("fallback", {
    fetchImpl,
    navigatorImpl: { sendBeacon: () => false },
    preferBeacon: true,
  });
  await releaseTorrentSession("explicit", { explicit: true, fetchImpl });

  assert.deepEqual(calls, [
    ["/api/torrents/fallback/release", { method: "POST", keepalive: true }],
    ["/api/torrents/explicit", { method: "DELETE", keepalive: true }],
  ]);
});
