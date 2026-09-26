import assert from "node:assert/strict";
import test from "node:test";
import {
  DELETE,
  GET,
  POST,
} from "../app/api/torrents/[id]/files/[fileId]/prefetch/route.js";

const torrentStateKey = Symbol.for("torplay.torrentState");
const debridStateKey = Symbol.for("torplay.debridSessions");

function context(id = "local-session", fileId = "0") {
  return { params: Promise.resolve({ id, fileId }) };
}

function localState(completed) {
  const file = { name: "Show.S01E02.mp4", path: "Show.S01E02.mp4",
    offset: 0, length: 32 * 1024 * 1024 };
  const torrent = {
    files: [file], pieceLength: 16 * 1024 * 1024,
    bitfield: { get: (piece) => completed.has(piece) },
    select() {}, deselect() {},
  };
  const resource = { status: "ready", torrent, pieceRefs: new Map(), mediaProbes: new Map() };
  const session = {
    id: "local-session", resource, selectedFileId: null, priorityLease: null,
    prefetch: null, activeConversion: null, lastActivity: 0,
  };
  return {
    sessions: new Map([[session.id, session]]), resources: new Map(), resourceStarts: new Map(),
    client: null, mediaServer: null, mediaServerReady: null, storageReady: Promise.resolve(),
    cleanupTimer: null, lastSubtitleCleanupAt: 0,
  };
}

function emptyDebridState() {
  return {
    sessions: new Map(), resources: new Map(), localResolution: new Map(),
    availabilityCache: new Map(), inflight: new Map(), cooldown: new Map(),
    server: null, port: null, bridgeKey: "test", cleanupTimer: null,
  };
}

test("prefetch route starts, reports, and cancels a local startup buffer", async () => {
  const previousTorrent = globalThis[torrentStateKey];
  const previousDebrid = globalThis[debridStateKey];
  const completed = new Set();
  globalThis[torrentStateKey] = localState(completed);
  globalThis[debridStateKey] = emptyDebridState();
  try {
    const started = await POST(new Request("http://localhost/prefetch", { method: "POST" }), context());
    assert.equal(started.status, 200);
    assert.deepEqual(await started.json(), {
      state: "preparing", fileId: "0", targetBytes: 32 * 1024 * 1024, downloadedBytes: 0,
    });

    completed.add(0);
    completed.add(1);
    const status = await GET(new Request("http://localhost/prefetch"), context());
    assert.equal((await status.json()).state, "ready");

    const stopped = await DELETE(new Request("http://localhost/prefetch", { method: "DELETE" }), context());
    assert.deepEqual(await stopped.json(), { state: "idle", cancelled: true });
  } finally {
    if (previousTorrent === undefined) delete globalThis[torrentStateKey];
    else globalThis[torrentStateKey] = previousTorrent;
    if (previousDebrid === undefined) delete globalThis[debridStateKey];
    else globalThis[debridStateKey] = previousDebrid;
  }
});

test("prefetch route rejects debrid sessions without changing provider resources", async () => {
  const previousDebrid = globalThis[debridStateKey];
  const debrid = emptyDebridState();
  debrid.sessions.set("remote-session", {
    id: "remote-session", backend: "debrid", lastActivity: 0,
    resource: { torrent: { files: [{ name: "Show.S01E02.mp4", length: 100 }] } },
  });
  globalThis[debridStateKey] = debrid;
  try {
    const response = await POST(new Request("http://localhost/prefetch", { method: "POST" }),
      context("remote-session", "0"));
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "PREFETCH_UNSUPPORTED");
  } finally {
    if (previousDebrid === undefined) delete globalThis[debridStateKey];
    else globalThis[debridStateKey] = previousDebrid;
  }
});
