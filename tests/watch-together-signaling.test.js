import assert from "node:assert/strict";
import test from "node:test";
import WebSocket from "ws";
import {
  normalizeMediaIdentity,
  normalizeRoomCode,
  validatePublicRoomPayload,
} from "../lib/watch-together/protocol.js";
import { createWatchTogetherSignalingServer } from "../services/watch-together-signaling/server.js";
import {
  configuredRoomStore,
  createMemoryRoomStore,
} from "../services/watch-together-signaling/room-store.js";

test("normalizes public room identities and rejects private playback data", () => {
  assert.equal(normalizeRoomCode(" ab-c 234 "), "ABC234");
  assert.deepEqual(normalizeMediaIdentity({ mediaType: "movie", tmdbId: "42", sourceUrl: "ignored" }), {
    mediaType: "movie", tmdbId: 42,
  });
  assert.doesNotThrow(() => validatePublicRoomPayload({ type: "playback", position: 12.5, playing: true }));
  assert.throws(() => validatePublicRoomPayload({ url: "/api/torrents/private/files/file/stream" }),
    /not allowed|private playback data/);
});

test("supports memory and Redis room-store configuration", async () => {
  const defaultStore = configuredRoomStore({});
  const memory = configuredRoomStore({ WATCH_TOGETHER_STORE: "memory" });
  const redis = configuredRoomStore({
    WATCH_TOGETHER_STORE: "redis",
    WATCH_TOGETHER_REDIS_URL: "redis://127.0.0.1:6379",
  });
  assert.equal(defaultStore.kind, "memory");
  assert.equal(memory.kind, "memory");
  assert.equal(redis.kind, "redis");
  assert.throws(() => configuredRoomStore({ WATCH_TOGETHER_STORE: "file" }),
    /must be either "memory" or "redis"/);
  assert.throws(() => configuredRoomStore({ WATCH_TOGETHER_STORE: "redis" }),
    /WATCH_TOGETHER_REDIS_URL or REDIS_URL is required/);
  await defaultStore.close();
  await memory.close();
  await redis.close();
});

function open(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function nextMessage(socket, type, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${type}.`)), timeoutMs);
    const listener = (data) => {
      const value = JSON.parse(String(data));
      if (value.type !== type) return;
      clearTimeout(timer);
      socket.off("message", listener);
      resolve(value);
    };
    socket.on("message", listener);
  });
}

function send(socket, value) {
  socket.send(JSON.stringify({ protocol: 1, ...value }));
}

test("signaling service creates, joins, and closes rooms", async () => {
  const service = createWatchTogetherSignalingServer({ reconnectGraceMs: 25,
    roomStore: createMemoryRoomStore() });
  const address = await service.listen(0);
  const host = await open(`ws://127.0.0.1:${address.port}/signal`);
  const guest = await open(`ws://127.0.0.1:${address.port}/signal`);
  try {
    send(host, { type: "create", name: "Host", media: { mediaType: "movie", tmdbId: 42 } });
    const room = await nextMessage(host, "room");
    send(guest, { type: "join", name: "Guest", code: room.code });
    const joined = await nextMessage(guest, "room");
    assert.equal(joined.code, room.code);
    assert.equal(joined.role, "guest");
    send(host, { type: "leave" });
    assert.equal((await nextMessage(guest, "room-closed")).reason, "host-left");
  } finally {
    host.close();
    guest.close();
    await service.close();
  }
});
