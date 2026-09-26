import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";
import {
  WATCH_TOGETHER_CODE_ALPHABET,
  WATCH_TOGETHER_CODE_LENGTH,
  WATCH_TOGETHER_MAX_MESSAGE_BYTES,
  WATCH_TOGETHER_PROTOCOL_VERSION,
  WATCH_TOGETHER_ROOM_SIZE,
  normalizeMediaIdentity,
  normalizeParticipantName,
  normalizeRoomCode,
} from "../../lib/watch-together/protocol.js";
import { configuredRoomStore } from "./room-store.js";

const ROOM_TTL_MS = 12 * 60 * 60 * 1000;
const RECONNECT_GRACE_MS = 15_000;
const RATE_WINDOW_MS = 60_000;

function publicParticipant(participant) {
  return { id: participant.id, name: participant.name, role: participant.role, connected: participant.connected };
}

function send(socket, value) {
  if (socket?.readyState === socket.OPEN) socket.send(JSON.stringify(value));
}

function error(socket, code, message) {
  send(socket, { type: "error", code, message });
}

export function createWatchTogetherSignalingServer({
  now = () => Date.now(),
  random = randomBytes,
  roomTtlMs = ROOM_TTL_MS,
  reconnectGraceMs = RECONNECT_GRACE_MS,
  allowedOrigins = process.env.WATCH_TOGETHER_ALLOWED_ORIGINS || "",
  roomStore = null,
} = {}) {
  const lifecycleStore = roomStore || configuredRoomStore();
  const rooms = new Map();
  const roomLoads = new Map();
  const socketState = new WeakMap();
  const rateBuckets = new Map();
  const origins = new Set(String(allowedOrigins).split(",").map((value) => value.trim()).filter(Boolean));

  function roomCode() {
    const bytes = random(WATCH_TOGETHER_CODE_LENGTH);
    return [...bytes].map((byte) => WATCH_TOGETHER_CODE_ALPHABET[byte % WATCH_TOGETHER_CODE_ALPHABET.length]).join("");
  }

  function allow(ip, kind) {
    const key = `${ip}:${kind}`;
    const limit = kind === "create" ? 5 : 20;
    const stamp = now();
    const bucket = rateBuckets.get(key);
    if (!bucket || bucket.resetAt <= stamp) {
      rateBuckets.set(key, { count: 1, resetAt: stamp + RATE_WINDOW_MS });
      return true;
    }
    bucket.count += 1;
    return bucket.count <= limit;
  }

  function roster(room) {
    return [...room.participants.values()].map(publicParticipant);
  }

  function broadcast(room, value, exceptId = null) {
    for (const participant of room.participants.values()) {
      if (participant.id !== exceptId) send(participant.socket, value);
    }
  }

  function publishRoster(room) {
    broadcast(room, { type: "roster", participants: roster(room) });
  }

  function storedRoom(room) {
    return {
      code: room.code,
      media: room.media,
      hostId: room.hostId,
      createdAt: room.createdAt,
      expiresAt: room.expiresAt,
      participants: [...room.participants.values()].map((participant) => ({
        id: participant.id,
        token: participant.token,
        name: participant.name,
        role: participant.role,
      })),
    };
  }

  function closeRoom(room, reason = "host-left", { deleteStored = true } = {}) {
    if (!rooms.has(room.code)) return;
    rooms.delete(room.code);
    clearTimeout(room.hostTimer);
    for (const participant of room.participants.values()) {
      clearTimeout(participant.disconnectTimer);
      send(participant.socket, { type: "room-closed", reason });
      socketState.delete(participant.socket);
    }
    room.participants.clear();
    if (deleteStored) void lifecycleStore.deleteRoom(room.code).catch(() => {});
  }

  async function expireParticipant(room, participant) {
    if (participant.connected || !rooms.has(room.code)) return;
    if (participant.role === "host") {
      closeRoom(room, "host-disconnected");
      return;
    }
    room.participants.delete(participant.id);
    await lifecycleStore.removeParticipant(room.code, participant.id).catch(() => false);
    send(room.participants.get(room.hostId)?.socket, { type: "peer-left", participantId: participant.id });
    publishRoster(room);
  }

  function scheduleDisconnect(room, participant) {
    clearTimeout(participant.disconnectTimer);
    participant.disconnectTimer = setTimeout(() => void expireParticipant(room, participant), reconnectGraceMs);
    participant.disconnectTimer.unref?.();
    if (participant.role === "host") room.hostTimer = participant.disconnectTimer;
  }

  async function loadRoom(code) {
    if (rooms.has(code)) return rooms.get(code);
    if (roomLoads.has(code)) return roomLoads.get(code);
    const loading = lifecycleStore.getRoom(code).then((record) => {
      if (!record || record.expiresAt <= now()) {
        if (record) void lifecycleStore.deleteRoom(code).catch(() => {});
        return null;
      }
      let media;
      try { media = normalizeMediaIdentity(record.media); }
      catch { void lifecycleStore.deleteRoom(code).catch(() => {}); return null; }
      const participants = new Map((record.participants || []).map((participant) => [participant.id, {
        id: participant.id,
        token: participant.token,
        name: participant.name,
        role: participant.role,
        connected: false,
        socket: null,
        disconnectTimer: null,
      }]));
      if (!participants.has(record.hostId)) {
        void lifecycleStore.deleteRoom(code).catch(() => {});
        return null;
      }
      const room = { code, media, hostId: record.hostId, createdAt: record.createdAt,
        expiresAt: record.expiresAt, participants, hostTimer: null };
      rooms.set(code, room);
      for (const participant of participants.values()) scheduleDisconnect(room, participant);
      return room;
    }).finally(() => roomLoads.delete(code));
    roomLoads.set(code, loading);
    return loading;
  }

  function attach(socket, room, participant) {
    clearTimeout(participant.disconnectTimer);
    if (participant.role === "host") clearTimeout(room.hostTimer);
    participant.socket = socket;
    participant.connected = true;
    socketState.set(socket, { room, participant });
    send(socket, {
      type: "room",
      protocol: WATCH_TOGETHER_PROTOCOL_VERSION,
      code: room.code,
      participantId: participant.id,
      reconnectToken: participant.token,
      role: participant.role,
      media: room.media,
      participants: roster(room),
      expiresAt: room.expiresAt,
    });
    publishRoster(room);
  }

  async function create(socket, message, ip) {
    if (!allow(ip, "create")) return error(socket, "RATE_LIMITED", "Too many rooms were created from this address.");
    let media;
    let name;
    try {
      media = normalizeMediaIdentity(message.media);
      name = normalizeParticipantName(message.name);
    } catch (validationError) {
      return error(socket, "INVALID_REQUEST", validationError.message);
    }
    const host = { id: randomUUID(), token: randomUUID(), name, role: "host", connected: true, socket };
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const code = roomCode();
      const room = {
        code, media, hostId: host.id, createdAt: now(), expiresAt: now() + roomTtlMs,
        participants: new Map([[host.id, host]]), hostTimer: null,
      };
      if (!await lifecycleStore.createRoom(storedRoom(room))) continue;
      rooms.set(code, room);
      attach(socket, room, host);
      return;
    }
    throw new Error("A room code could not be allocated.");
  }

  async function join(socket, message, ip) {
    if (!allow(ip, "join")) return error(socket, "RATE_LIMITED", "Too many room joins were attempted from this address.");
    let code;
    let name;
    try {
      code = normalizeRoomCode(message.code);
      name = normalizeParticipantName(message.name);
    } catch (validationError) {
      return error(socket, "INVALID_REQUEST", validationError.message);
    }
    const room = await loadRoom(code);
    if (!room) return error(socket, "ROOM_NOT_FOUND", "That room does not exist or has closed.");
    const participant = { id: randomUUID(), token: randomUUID(), name, role: "guest", connected: true, socket };
    const stored = await lifecycleStore.addParticipant(code, {
      id: participant.id, token: participant.token, name: participant.name, role: participant.role,
    }, WATCH_TOGETHER_ROOM_SIZE, now());
    if (stored.status === "missing") return error(socket, "ROOM_NOT_FOUND", "That room does not exist or has closed.");
    if (stored.status === "full") return error(socket, "ROOM_FULL", "That room is full.");
    room.participants.set(participant.id, participant);
    attach(socket, room, participant);
    send(room.participants.get(room.hostId)?.socket, { type: "peer-joined", participant: publicParticipant(participant) });
  }

  async function resume(socket, message) {
    let code;
    try { code = normalizeRoomCode(message.code); }
    catch (validationError) { return error(socket, "INVALID_REQUEST", validationError.message); }
    const room = await loadRoom(code);
    const participant = [...(room?.participants.values() || [])]
      .find((candidate) => candidate.id === message.participantId && candidate.token === message.reconnectToken);
    if (!room || !participant) return error(socket, "RESUME_REJECTED", "The room session could not be resumed.");
    participant.socket?.close(4001, "Replaced by resumed connection");
    attach(socket, room, participant);
    if (participant.role === "guest") {
      send(room.participants.get(room.hostId)?.socket, { type: "peer-joined", participant: publicParticipant(participant), resumed: true });
    }
  }

  function relay(socket, message) {
    const state = socketState.get(socket);
    if (!state) return error(socket, "NOT_JOINED", "Join a room before relaying signaling data.");
    const { room, participant } = state;
    const target = room.participants.get(message.targetId);
    const starAllowed = participant.role === "host"
      ? target?.role === "guest"
      : target?.id === room.hostId;
    if (!starAllowed || !new Set(["offer", "answer", "ice"]).has(message.kind)) {
      return error(socket, "INVALID_RELAY", "That signaling relay is not allowed.");
    }
    send(target.socket, {
      type: "signal", fromId: participant.id, kind: message.kind, payload: message.payload,
    });
  }

  async function changeMedia(socket, message) {
    const state = socketState.get(socket);
    if (!state || state.participant.role !== "host") return error(socket, "HOST_ONLY", "Only the host can change media.");
    let media;
    try { media = normalizeMediaIdentity(message.media); }
    catch (validationError) { return error(socket, "INVALID_REQUEST", validationError.message); }
    if (!await lifecycleStore.updateMedia(state.room.code, media)) {
      return error(socket, "ROOM_NOT_FOUND", "That room does not exist or has closed.");
    }
    state.room.media = media;
    broadcast(state.room, { type: "media-changed", media }, state.participant.id);
  }

  async function leave(socket) {
    const state = socketState.get(socket);
    if (!state) return;
    const { room, participant } = state;
    socketState.delete(socket);
    if (participant.role === "host") {
      await lifecycleStore.deleteRoom(room.code);
      closeRoom(room, "host-left", { deleteStored: false });
    }
    else {
      await lifecycleStore.removeParticipant(room.code, participant.id);
      room.participants.delete(participant.id);
      clearTimeout(participant.disconnectTimer);
      send(room.participants.get(room.hostId)?.socket, { type: "peer-left", participantId: participant.id });
      publishRoster(room);
    }
  }

  const httpServer = createServer((request, response) => {
    if (request.url === "/health") {
      const healthy = lifecycleStore.ready;
      response.writeHead(healthy ? 200 : 503, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      });
      response.end(JSON.stringify({ status: healthy ? "ok" : "unavailable",
        service: "torplay-watch-together", protocol: WATCH_TOGETHER_PROTOCOL_VERSION,
        roomStore: lifecycleStore.kind }));
      return;
    }
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "Not found." }));
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: WATCH_TOGETHER_MAX_MESSAGE_BYTES });

  httpServer.on("upgrade", (request, socket, head) => {
    const origin = String(request.headers.origin || "");
    if (request.url !== "/signal" || (origins.size && !origins.has(origin))) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (webSocket) => sockets.emit("connection", webSocket, request));
  });

  sockets.on("connection", (socket, request) => {
    const ip = request.socket.remoteAddress || "unknown";
    socket.on("message", (data) => {
      let message;
      try { message = JSON.parse(String(data)); }
      catch { return error(socket, "INVALID_JSON", "Messages must be valid JSON."); }
      if (message?.protocol !== undefined && message.protocol !== WATCH_TOGETHER_PROTOCOL_VERSION) {
        return error(socket, "PROTOCOL_MISMATCH", "This TorPlay version is not compatible with the signaling service.");
      }
      let operation;
      if (message?.type === "create") operation = create(socket, message, ip);
      else if (message?.type === "join") operation = join(socket, message, ip);
      else if (message?.type === "resume") operation = resume(socket, message);
      else if (message?.type === "relay") operation = relay(socket, message);
      else if (message?.type === "change-media") operation = changeMedia(socket, message);
      else if (message?.type === "leave") operation = leave(socket);
      else return error(socket, "UNKNOWN_MESSAGE", "Unknown signaling message.");
      Promise.resolve(operation).catch(() => error(socket, "SERVICE_UNAVAILABLE",
        "Watch Together room storage is temporarily unavailable."));
    });
    socket.on("close", () => {
      const state = socketState.get(socket);
      if (!state || state.participant.socket !== socket) return;
      const { room, participant } = state;
      socketState.delete(socket);
      participant.connected = false;
      participant.socket = null;
      publishRoster(room);
      scheduleDisconnect(room, participant);
    });
  });

  const cleanupTimer = setInterval(() => {
    const stamp = now();
    for (const room of rooms.values()) if (room.expiresAt <= stamp) closeRoom(room, "expired");
    for (const [key, bucket] of rateBuckets) if (bucket.resetAt <= stamp) rateBuckets.delete(key);
  }, 30_000);
  cleanupTimer.unref?.();

  return {
    httpServer,
    rooms,
    async listen(port = Number(process.env.PORT) || 8787, host = process.env.HOST || "127.0.0.1") {
      await lifecycleStore.connect();
      await new Promise((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(port, host, () => {
          httpServer.removeListener("error", reject);
          resolve();
        });
      });
      return httpServer.address();
    },
    async close() {
      clearInterval(cleanupTimer);
      for (const room of rooms.values()) {
        clearTimeout(room.hostTimer);
        for (const participant of room.participants.values()) {
          clearTimeout(participant.disconnectTimer);
          socketState.delete(participant.socket);
          participant.socket?.close(1012, "Service restarting");
          participant.socket = null;
          participant.connected = false;
        }
      }
      rooms.clear();
      await new Promise((resolve) => sockets.close(() => httpServer.close(resolve)));
      await lifecycleStore.close();
    },
  };
}

async function main() {
  const service = createWatchTogetherSignalingServer();
  const address = await service.listen();
  console.log(`TorPlay Watch Together signaling listening on ${typeof address === "string" ? address : `${address.address}:${address.port}`}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
