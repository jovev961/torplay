import { createClient } from "redis";

const DEFAULT_PREFIX = "torplay:watch-together";

function clone(value) {
  return value ? structuredClone(value) : null;
}

function parseRoom(value) {
  if (!value) return null;
  try {
    const room = typeof value === "string" ? JSON.parse(value) : value;
    if (!room || typeof room !== "object" || !Array.isArray(room.participants)) return null;
    return room;
  } catch {
    return null;
  }
}

export function createMemoryRoomStore() {
  const records = new Map();
  return {
    kind: "memory",
    get ready() { return true; },
    async connect() {},
    async createRoom(room) {
      if (records.has(room.code)) return false;
      records.set(room.code, clone(room));
      return true;
    },
    async getRoom(code) {
      return clone(records.get(code));
    },
    async addParticipant(code, participant, maximum) {
      const room = records.get(code);
      if (!room) return { status: "missing" };
      if (room.participants.some((entry) => entry.id === participant.id)) {
        return { status: "joined", room: clone(room) };
      }
      if (room.participants.length >= maximum) return { status: "full" };
      room.participants.push(clone(participant));
      return { status: "joined", room: clone(room) };
    },
    async updateMedia(code, media) {
      const room = records.get(code);
      if (!room) return false;
      room.media = clone(media);
      return true;
    },
    async removeParticipant(code, participantId) {
      const room = records.get(code);
      if (!room) return false;
      room.participants = room.participants.filter((participant) => participant.id !== participantId);
      return true;
    },
    async deleteRoom(code) {
      return records.delete(code);
    },
    async close() {
      records.clear();
    },
  };
}

const CREATE_ROOM = `
if redis.call("EXISTS", KEYS[1]) == 1 then return 0 end
redis.call("SET", KEYS[1], ARGV[1])
redis.call("PEXPIREAT", KEYS[1], ARGV[2])
return 1
`;

const ADD_PARTICIPANT = `
local raw = redis.call("GET", KEYS[1])
if not raw then return { "missing" } end
local room = cjson.decode(raw)
if tonumber(room.expiresAt) <= tonumber(ARGV[3]) then
  redis.call("DEL", KEYS[1])
  return { "missing" }
end
for _, participant in ipairs(room.participants) do
  if participant.id == ARGV[1] then return { "joined", raw } end
end
if #room.participants >= tonumber(ARGV[2]) then return { "full" } end
table.insert(room.participants, cjson.decode(ARGV[4]))
local updated = cjson.encode(room)
redis.call("SET", KEYS[1], updated)
redis.call("PEXPIREAT", KEYS[1], room.expiresAt)
return { "joined", updated }
`;

const UPDATE_MEDIA = `
local raw = redis.call("GET", KEYS[1])
if not raw then return 0 end
local room = cjson.decode(raw)
room.media = cjson.decode(ARGV[1])
local updated = cjson.encode(room)
redis.call("SET", KEYS[1], updated)
redis.call("PEXPIREAT", KEYS[1], room.expiresAt)
return 1
`;

const REMOVE_PARTICIPANT = `
local raw = redis.call("GET", KEYS[1])
if not raw then return 0 end
local room = cjson.decode(raw)
local kept = {}
for _, participant in ipairs(room.participants) do
  if participant.id ~= ARGV[1] then table.insert(kept, participant) end
end
room.participants = kept
local updated = cjson.encode(room)
redis.call("SET", KEYS[1], updated)
redis.call("PEXPIREAT", KEYS[1], room.expiresAt)
return 1
`;

export function createRedisRoomStore({ url, prefix = DEFAULT_PREFIX, client = null } = {}) {
  if (!url && !client) throw new Error("A Redis URL is required.");
  const redis = client || createClient({ url });
  if (!client) redis.on("error", (error) => console.error(`Watch Together Redis error: ${error.message}`));
  const key = (code) => `${prefix}:room:${code}`;

  return {
    kind: "redis",
    get ready() { return redis.isReady === true; },
    async connect() {
      if (!redis.isOpen) await redis.connect();
    },
    async createRoom(room) {
      return Number(await redis.eval(CREATE_ROOM, {
        keys: [key(room.code)],
        arguments: [JSON.stringify(room), String(room.expiresAt)],
      })) === 1;
    },
    async getRoom(code) {
      return parseRoom(await redis.get(key(code)));
    },
    async addParticipant(code, participant, maximum, timestamp = Date.now()) {
      const result = await redis.eval(ADD_PARTICIPANT, {
        keys: [key(code)],
        arguments: [participant.id, String(maximum), String(timestamp), JSON.stringify(participant)],
      });
      const status = String(result?.[0] || "missing");
      return { status, room: parseRoom(result?.[1]) };
    },
    async updateMedia(code, media) {
      return Number(await redis.eval(UPDATE_MEDIA, {
        keys: [key(code)], arguments: [JSON.stringify(media)],
      })) === 1;
    },
    async removeParticipant(code, participantId) {
      return Number(await redis.eval(REMOVE_PARTICIPANT, {
        keys: [key(code)], arguments: [participantId],
      })) === 1;
    },
    async deleteRoom(code) {
      return Number(await redis.del(key(code))) > 0;
    },
    async close() {
      if (redis.isOpen) await redis.quit();
    },
  };
}

export function configuredRoomStore(environment = process.env) {
  const type = String(environment.WATCH_TOGETHER_STORE || "memory").trim().toLowerCase();
  if (type === "memory") return createMemoryRoomStore();
  if (type !== "redis") {
    throw new Error('WATCH_TOGETHER_STORE must be either "memory" or "redis".');
  }
  const url = String(environment.WATCH_TOGETHER_REDIS_URL || environment.REDIS_URL || "").trim();
  if (!url) {
    throw new Error("WATCH_TOGETHER_REDIS_URL or REDIS_URL is required when WATCH_TOGETHER_STORE=redis.");
  }
  const prefix = String(environment.WATCH_TOGETHER_REDIS_PREFIX || DEFAULT_PREFIX).trim() || DEFAULT_PREFIX;
  return createRedisRoomStore({ url, prefix });
}
