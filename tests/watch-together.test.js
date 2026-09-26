import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import WebSocket from "ws";
import {
  mediaIdentityHref,
  mediaIdentityKey,
  normalizeMediaIdentity,
  normalizeRoomCode,
  normalizeStunUrls,
  sameMediaIdentity,
  validatePublicRoomPayload,
} from "../lib/watch-together/protocol.js";
import {
  durationsCompatible,
  estimateClockOffset,
  guestCorrection,
  projectedHostPosition,
} from "../lib/watch-together/sync.js";
import {
  DEFAULT_WATCH_TOGETHER_STUN_URLS,
  normalizeSignalingBaseUrl,
  signalingHealthUrl,
  watchTogetherConfiguration,
} from "../lib/watch-together/config.js";
import { createWatchTogetherSignalingServer } from "../services/watch-together-signaling/server.js";
import {
  configuredRoomStore,
  createMemoryRoomStore,
} from "../services/watch-together-signaling/room-store.js";

test("normalizes room media identity and local deep links", () => {
  assert.equal(normalizeRoomCode(" ab-c 234 "), "ABC234");
  assert.throws(() => normalizeRoomCode("O0I111"), /six|6/i);
  assert.deepEqual(normalizeMediaIdentity({ mediaType: "movie", tmdbId: "42", sourceUrl: "ignored" }), {
    mediaType: "movie", tmdbId: 42,
  });
  const episode = normalizeMediaIdentity({ mediaType: "show", tmdbId: 99, seasonNumber: 0, episodeNumber: 3 });
  assert.deepEqual(episode, { mediaType: "tv", tmdbId: 99, seasonNumber: 0, episodeNumber: 3 });
  assert.equal(mediaIdentityKey(episode), "tv:99:0:3");
  assert.equal(sameMediaIdentity(episode, { ...episode, title: "Local title" }), true);
  assert.equal(mediaIdentityHref(episode), "/shows/99?season=0&episode=3");
});

test("room messages reject private source and credential data", () => {
  assert.doesNotThrow(() => validatePublicRoomPayload({ type: "playback", position: 12.5, playing: true }));
  assert.doesNotThrow(() => validatePublicRoomPayload({ type: "seek-start", id: 2, position: 45.25 }));
  assert.doesNotThrow(() => validatePublicRoomPayload({ type: "seek-ready", id: 2 }));
  for (const value of [
    { sessionId: "private" },
    { nested: { providerId: "real-debrid" } },
    { detail: "magnet:?xt=urn:btih:secret" },
    { url: "/api/torrents/private/files/file/stream" },
  ]) assert.throws(() => validatePublicRoomPayload(value), /not allowed|private playback data/);
});

test("validates signaling and STUN configuration without exposing secrets", () => {
  assert.equal(normalizeSignalingBaseUrl("https://signal.example.com/"), "https://signal.example.com");
  assert.equal(normalizeSignalingBaseUrl("http://localhost:8787"), "http://localhost:8787");
  assert.throws(() => normalizeSignalingBaseUrl("http://signal.example.com"), /HTTPS/);
  assert.equal(signalingHealthUrl("https://signal.example.com/base"), "https://signal.example.com/base/health");
  assert.deepEqual(normalizeStunUrls("stun:a.example,stuns:b.example"), ["stun:a.example", "stuns:b.example"]);
  const disabled = watchTogetherConfiguration({});
  assert.equal(disabled.enabled, false);
  assert.deepEqual(disabled.stunUrls, DEFAULT_WATCH_TOGETHER_STUN_URLS);
  const enabled = watchTogetherConfiguration({ WATCH_TOGETHER_SIGNAL_URL: "https://signal.example.com" });
  assert.equal(enabled.signalUrl, "wss://signal.example.com/signal");
});

test("calculates duration compatibility and bounded drift correction", () => {
  assert.equal(durationsCompatible(3600, 3604), true);
  assert.equal(durationsCompatible(3600, 3640), false);
  assert.equal(estimateClockOffset({ sentAt: 1000, hostAt: 1200, receivedAt: 1100 }), 150);
  assert.equal(projectedHostPosition({ position: 10, playing: true, sentAt: 1000 }, 2500, 0), 11.5);
  assert.deepEqual(guestCorrection({ currentTime: 10, targetTime: 10.1, playing: true }).kind, "rate");
  assert.equal(guestCorrection({ currentTime: 10, targetTime: 11, playing: true }).rate, 1.05);
  assert.equal(guestCorrection({ currentTime: 10, targetTime: 9, playing: true }).rate, 0.95);
  assert.equal(guestCorrection({ currentTime: 10, targetTime: 13, playing: true }).kind, "seek");
  assert.equal(guestCorrection({ currentTime: 10, targetTime: 10.1, playing: false }).kind, "seek");
  assert.equal(guestCorrection({ currentTime: 10, targetTime: 10.1,
    playing: true, explicit: true }).kind, "rate");
});

test("Watch Together configuration bootstraps once through the current socket callback", async () => {
  const source = await readFile(new URL("../components/WatchTogetherProvider.js", import.meta.url), "utf8");
  const start = source.indexOf('void fetch("/api/watch-together/config"');
  const end = source.indexOf("\n\n  useEffect(() => {", start);
  const effect = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(effect, /openSocketRef\.current\?\.\(\{ type: "resume"/);
  assert.doesNotMatch(effect, /void openSocket\(/);
  assert.match(effect, /}, \[\]\);/);
});

test("Watch Together uses the persistent dock for room creation and joining", async () => {
  const [dock, header, movie, show, provider] = await Promise.all([
    readFile(new URL("../components/WatchTogetherDock.js", import.meta.url), "utf8"),
    readFile(new URL("../components/AppHeader.js", import.meta.url), "utf8"),
    readFile(new URL("../components/MovieSource.js", import.meta.url), "utf8"),
    readFile(new URL("../components/ShowDetails.js", import.meta.url), "utf8"),
    readFile(new URL("../components/WatchTogetherProvider.js", import.meta.url), "utf8"),
  ]);

  assert.match(dock, /const \[expanded, setExpanded\] = useState\(false\)/);
  assert.match(dock, /Open Watch Together/);
  assert.match(dock, /Create room/);
  assert.match(dock, /Join room/);
  assert.match(dock, /party\.createRoom\(party\.pageMedia\)/);
  assert.match(dock, /party\.joinRoom\(code\)/);
  assert.doesNotMatch(header, /href: "\/watch-together"/);
  assert.doesNotMatch(movie, /WatchTogetherActions/);
  assert.doesNotMatch(show, /WatchTogetherActions/);
  assert.match(provider, /registerPageMedia/);
});

test("Watch Together guests follow host media but keep their own source selection", async () => {
  const [movie, show] = await Promise.all([
    readFile(new URL("../components/MovieSource.js", import.meta.url), "utf8"),
    readFile(new URL("../components/ShowDetails.js", import.meta.url), "utf8"),
  ]);

  assert.match(movie, /watchTogether\.isGuest[\s\S]*!sameMediaIdentity/);
  assert.match(movie, /router\.replace\(roomMediaHref\)/);
  assert.match(movie, /<SourcePanel/);
  assert.match(show, /const guestMediaLocked = Boolean\(watchTogether\.isGuest/);
  assert.match(show, /if \(guestMediaLocked\) return;/);
  assert.match(show, /disabled=\{loadingSeason \|\| guestMediaLocked\}/);
  assert.match(show, /disabled=\{guestMediaLocked\}/);
  assert.match(show, /Choose your source above/);
  assert.match(show, /router\.replace\(roomMediaHref\)/);
});

test("Watch Together resumes a changed episode only after every participant is ready", async () => {
  const source = await readFile(new URL("../components/WatchTogetherProvider.js", import.meta.url), "utf8");
  const changeStart = source.indexOf("const changeMedia = useCallback");
  const changeEnd = source.indexOf("\n\n  const attachPlayer", changeStart);
  const changeMedia = source.slice(changeStart, changeEnd);
  assert.match(changeMedia, /resumeAfterMediaChangeRef\.current = true/);

  const resetStart = source.indexOf("const resetMediaState = useCallback");
  const resetEnd = source.indexOf("\n\n  const handleSocketMessage", resetStart);
  const resetMedia = source.slice(resetStart, resetEnd);
  assert.match(resetMedia, /playerRef\.current\?\.pause\(\)/);
  assert.match(resetMedia, /peer\?\.channel\?\.readyState === "open"/);
  assert.match(resetMedia, /\? "connected" : previous\.channel \|\| "connecting"/);
  assert.doesNotMatch(resetMedia, /setPeerRoster\(\{\}\)/);

  const resumeStart = source.indexOf('if (room?.role !== "host" || !allReady || !resumeAfterMediaChangeRef.current)');
  const resumeEnd = source.indexOf("\n\n  useEffect", resumeStart);
  const resumeEffect = source.slice(resumeStart, resumeEnd);
  assert.ok(resumeStart >= 0 && resumeEnd > resumeStart);
  assert.match(resumeEffect, /void player\.play\(\)\.then\(\(\) => playbackSnapshot\(true\)\)/);
});

test("Watch Together ignores stale player cleanup after moving the room", async () => {
  const source = await readFile(new URL("../components/WatchTogetherProvider.js", import.meta.url), "utf8");
  const attachStart = source.indexOf("const attachPlayer = useCallback");
  const attachEnd = source.indexOf("\n\n  const reportPlayer", attachStart);
  const attachPlayer = source.slice(attachStart, attachEnd);
  const ownershipGuard = attachPlayer.indexOf("if (playerRef.current !== controller) return;");
  const clearPlayback = attachPlayer.indexOf("setLocalPlayback", ownershipGuard);

  assert.ok(attachStart >= 0 && attachEnd > attachStart);
  assert.ok(ownershipGuard >= 0 && clearPlayback > ownershipGuard);
});

test("Watch Together pauses guests before seeking and waits for the current seek barrier", async () => {
  const source = await readFile(new URL("../components/WatchTogetherProvider.js", import.meta.url), "utf8");
  const guestStart = source.indexOf('if (message.type === "seek-start")');
  const guestEnd = source.indexOf('} else if (message.type === "roster"', guestStart);
  const guestSeek = source.slice(guestStart, guestEnd);
  assert.ok(guestStart >= 0 && guestEnd > guestStart);
  assert.match(source, /await player\.pauseForSync\(\);\s+await player\.seek\(transition\.position\)/);
  assert.match(guestSeek, /message\.id <= \(guestSeekRef\.current\?\.id \|\| 0\)/);

  const hostStart = source.indexOf("const seekTogether = useCallback");
  const hostEnd = source.indexOf("\n\n  const retrySeekSync", hostStart);
  const hostSeek = source.slice(hostStart, hostEnd);
  assert.match(hostSeek, /resumePlaying: Boolean\(player\.getState\(\)\.playing\)/);
  assert.ok(hostSeek.indexOf("activeSeekRef.current = transition") < hostSeek.indexOf("performHostSeek(transition)"));
  assert.ok(hostSeek.indexOf("performHostSeek(transition)") < hostSeek.indexOf('type: "seek-start"'));

  const readyStart = source.indexOf('message.type === "seek-ready" || message.type === "seek-failed"');
  const readyEnd = source.indexOf('} else if (message.type === "ping")', readyStart);
  assert.match(source.slice(readyStart, readyEnd), /message\.id !== transition\.id/);
});

test("VideoPlayer delegates host seeks to the room transaction", async () => {
  const source = await readFile(new URL("../components/VideoPlayer.js", import.meta.url), "utf8");
  const start = source.indexOf("function requestSeek(");
  const end = source.indexOf("\n\n  function skipBy", start);
  const requestSeek = source.slice(start, end);
  assert.match(requestSeek, /watchTogether\.seekTogether\(next\)/);
  assert.match(requestSeek, /watchTogetherActive && watchTogether\?\.isHost && !fromWatchTogether/);
  assert.match(source, /video\.currentTime = next;\s+await waitForSynchronizedPosition\(video, next\)/);
  assert.match(source, /preparePlayback\(next, selectedAudioStreamIndex, false, true\)/);
  assert.match(source, /waitForDecodedFrame\(video, \{ signal: readyController\.signal \}\)/);
  assert.match(source, /\["loadeddata", "canplay", "seeked", "torplayhlsbuffered"\]/);
  assert.match(source, /startFragPrefetch: true/);
  assert.match(source, /await playForSync\(video\)/);
  assert.match(source, /video\.muted = true;[\s\S]*await video\.play\(\);[\s\S]*video\.muted = wasMuted/);
  assert.match(source, /event\?\.type === "torplayhlsbuffered"/);
  assert.match(source, /did not buffer the shared position in time/);
  assert.match(source, /Hls\.Events\.FRAG_BUFFERED/);
});

test("Watch Together gives transient peer disconnects a recovery window", async () => {
  const source = await readFile(new URL("../components/WatchTogetherProvider.js", import.meta.url), "utf8");
  const start = source.indexOf("const wirePeer = useCallback");
  const end = source.indexOf("\n\n  const createHostPeer", start);
  const wirePeer = source.slice(start, end);
  assert.match(wirePeer, /connectionState === "disconnected"\) waitForPeerRecovery\(\)/);
  assert.match(wirePeer, /channel: "reconnecting"/);
  assert.match(wirePeer, /10_000/);
  assert.match(wirePeer, /connectionState === "connected"\) restorePeer\(\)/);
  assert.match(wirePeer, /attempts > 3/);
});

test("Watch Together coalesces playback updates and preserves connected peer state", async () => {
  const source = await readFile(new URL("../components/WatchTogetherProvider.js", import.meta.url), "utf8");
  const drainStart = source.indexOf("const drainGuestPlayback = useCallback");
  const drainEnd = source.indexOf("\n\n  const handleChannelMessage", drainStart);
  const drain = source.slice(drainStart, drainEnd);
  assert.match(drain, /while \(pendingGuestPlaybackRef\.current\)/);
  assert.match(drain, /Number\(message\.sequence\) < guestSequenceRef\.current/);
  assert.match(drain, /playbackError\?\.name === "AbortError"/);
  assert.match(drain, /playbackError\?\.name === "NotAllowedError"/);

  const rosterStart = source.indexOf('message.type === "roster"');
  const rosterEnd = source.indexOf('} else if (message.type === "pong")', rosterStart);
  assert.match(source.slice(rosterStart, rosterEnd), /\{ \.\.\.currentRoster\[participant\.id\], \.\.\.participant \}/);
});

class Messages {
  constructor(socket) {
    this.queue = [];
    this.waiters = [];
    socket.on("message", (data) => {
      const value = JSON.parse(String(data));
      const index = this.waiters.findIndex((waiter) => waiter.type === value.type);
      if (index >= 0) this.waiters.splice(index, 1)[0].resolve(value);
      else this.queue.push(value);
    });
  }

  next(type, timeoutMs = 2_000) {
    const index = this.queue.findIndex((value) => value.type === type);
    if (index >= 0) return Promise.resolve(this.queue.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { type, resolve };
      this.waiters.push(waiter);
      const timer = setTimeout(() => {
        const waiterIndex = this.waiters.indexOf(waiter);
        if (waiterIndex >= 0) this.waiters.splice(waiterIndex, 1);
        reject(new Error(`Timed out waiting for ${type}.`));
      }, timeoutMs);
      waiter.resolve = (value) => { clearTimeout(timer); resolve(value); };
    });
  }
}

function open(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("open", () => resolve({ socket, messages: new Messages(socket) }));
    socket.once("error", reject);
  });
}

function send(socket, value) {
  socket.send(JSON.stringify({ protocol: 1, ...value }));
}

function trackedRoomStore(base = createMemoryRoomStore()) {
  const calls = [];
  return {
    calls,
    base,
    kind: base.kind,
    get ready() { return base.ready; },
    connect: () => base.connect(),
    close: () => base.close(),
    ...Object.fromEntries(["createRoom", "getRoom", "addParticipant", "updateMedia",
      "removeParticipant", "deleteRoom"].map((method) => [method, async (...argumentsList) => {
      calls.push(method);
      return base[method](...argumentsList);
    }])),
  };
}

test("room lifecycle storage contains only durable room and membership state", async () => {
  const store = createMemoryRoomStore();
  const room = {
    code: "ABC234",
    media: { mediaType: "movie", tmdbId: 42 },
    hostId: "host",
    createdAt: 1_000,
    expiresAt: 10_000,
    participants: [{ id: "host", token: "secret", name: "Host", role: "host" }],
  };
  assert.equal(await store.createRoom(room), true);
  assert.equal((await store.addParticipant("ABC234",
    { id: "guest", token: "reconnect", name: "Guest", role: "guest" }, 8)).status, "joined");
  await store.updateMedia("ABC234", { mediaType: "tv", tmdbId: 99, seasonNumber: 1, episodeNumber: 2 });
  const stored = await store.getRoom("ABC234");
  assert.deepEqual(Object.keys(stored).sort(),
    ["code", "createdAt", "expiresAt", "hostId", "media", "participants"].sort());
  assert.equal(stored.position, undefined);
  assert.equal(stored.playing, undefined);
  assert.equal(stored.buffering, undefined);
  assert.equal(stored.participants.length, 2);
  await store.removeParticipant("ABC234", "guest");
  assert.equal((await store.getRoom("ABC234")).participants.length, 1);
});

test("room store configuration supports explicit memory and Redis modes", async () => {
  const defaultStore = configuredRoomStore({});
  const memory = configuredRoomStore({ WATCH_TOGETHER_STORE: "memory" });
  assert.equal(defaultStore.kind, "memory");
  assert.equal(memory.kind, "memory");

  const redis = configuredRoomStore({
    WATCH_TOGETHER_STORE: "redis",
    WATCH_TOGETHER_REDIS_URL: "redis://127.0.0.1:6379",
  });
  assert.equal(redis.kind, "redis");

  await defaultStore.close();
  await memory.close();
  await redis.close();
});

test("room store configuration rejects invalid or incomplete modes", () => {
  assert.throws(() => configuredRoomStore({ WATCH_TOGETHER_STORE: "file" }),
    /must be either "memory" or "redis"/);
  assert.throws(() => configuredRoomStore({ WATCH_TOGETHER_STORE: "redis" }),
    /WATCH_TOGETHER_REDIS_URL or REDIS_URL is required/);
});

test("Redis-style lifecycle persistence restores a room after a signaling restart", async () => {
  const memory = createMemoryRoomStore();
  const persistentStore = { ...memory, ready: true, close: async () => {} };
  const firstService = createWatchTogetherSignalingServer({ roomStore: persistentStore });
  const firstAddress = await firstService.listen(0);
  const host = await open(`ws://127.0.0.1:${firstAddress.port}/signal`);
  send(host.socket, { type: "create", name: "Host", media: { mediaType: "movie", tmdbId: 42 } });
  const created = await host.messages.next("room");
  await firstService.close();

  const secondService = createWatchTogetherSignalingServer({ roomStore: persistentStore });
  const secondAddress = await secondService.listen(0);
  const resumed = await open(`ws://127.0.0.1:${secondAddress.port}/signal`);
  try {
    send(resumed.socket, { type: "resume", code: created.code, participantId: created.participantId,
      reconnectToken: created.reconnectToken });
    const restored = await resumed.messages.next("room");
    assert.equal(restored.code, created.code);
    assert.equal(restored.role, "host");
    assert.deepEqual(restored.media, { mediaType: "movie", tmdbId: 42 });
  } finally {
    resumed.socket.close();
    await secondService.close();
    await memory.close();
  }
});

test("signaling service creates, joins, relays, changes media, and closes with the host", async () => {
  const store = trackedRoomStore();
  const service = createWatchTogetherSignalingServer({ reconnectGraceMs: 25, roomStore: store });
  const address = await service.listen(0);
  const base = `http://127.0.0.1:${address.port}`;
  const sockets = [];
  try {
    const health = await fetch(`${base}/health`).then((response) => response.json());
    assert.deepEqual(health, { status: "ok", service: "torplay-watch-together", protocol: 1,
      roomStore: "memory" });

    const host = await open(`ws://127.0.0.1:${address.port}/signal`);
    const guest = await open(`ws://127.0.0.1:${address.port}/signal`);
    sockets.push(host.socket, guest.socket);
    send(host.socket, { type: "create", name: "Host", media: { mediaType: "movie", tmdbId: 42 } });
    const hostRoom = await host.messages.next("room");
    assert.match(hostRoom.code, /^[A-HJ-NP-Z2-9]{6}$/);
    assert.equal(hostRoom.role, "host");

    send(guest.socket, { type: "join", name: "Guest", code: hostRoom.code });
    const guestRoom = await guest.messages.next("room");
    assert.equal(guestRoom.role, "guest");
    assert.deepEqual(guestRoom.media, { mediaType: "movie", tmdbId: 42 });
    const joined = await host.messages.next("peer-joined");
    assert.equal(joined.participant.id, guestRoom.participantId);

    const offer = { type: "offer", sdp: "test-offer" };
    const storageCallsBeforeRelay = store.calls.length;
    send(host.socket, { type: "relay", targetId: guestRoom.participantId, kind: "offer", payload: offer });
    const relayed = await guest.messages.next("signal");
    assert.equal(relayed.fromId, hostRoom.participantId);
    assert.deepEqual(relayed.payload, offer);
    assert.equal(store.calls.length, storageCallsBeforeRelay);

    send(guest.socket, { type: "change-media", media: { mediaType: "movie", tmdbId: 7 } });
    assert.equal((await guest.messages.next("error")).code, "HOST_ONLY");
    send(host.socket, { type: "change-media", media: {
      mediaType: "tv", tmdbId: 99, seasonNumber: 2, episodeNumber: 4,
    } });
    assert.deepEqual((await guest.messages.next("media-changed")).media, {
      mediaType: "tv", tmdbId: 99, seasonNumber: 2, episodeNumber: 4,
    });
    assert.equal(store.calls.filter((method) => method === "updateMedia").length, 1);

    send(host.socket, { type: "leave" });
    assert.equal((await guest.messages.next("room-closed")).reason, "host-left");
  } finally {
    for (const socket of sockets) socket.close();
    await service.close();
  }
});
