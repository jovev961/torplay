export const WATCH_TOGETHER_PROTOCOL_VERSION = 1;
export const WATCH_TOGETHER_ROOM_SIZE = 8;
export const WATCH_TOGETHER_CODE_LENGTH = 6;
export const WATCH_TOGETHER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const WATCH_TOGETHER_MAX_MESSAGE_BYTES = 64 * 1024;

const FORBIDDEN_KEYS = new Set([
  "sessionId", "fileId", "filename", "fileName", "provider", "providerId",
  "magnet", "torrent", "source", "sourceUrl", "streamUrl", "playbackUrl",
  "apiKey", "token", "credential", "credentials",
]);

export function normalizeRoomCode(value) {
  const code = String(value || "").trim().toUpperCase().replace(/[\s-]+/g, "");
  if (code.length !== WATCH_TOGETHER_CODE_LENGTH
    || [...code].some((character) => !WATCH_TOGETHER_CODE_ALPHABET.includes(character))) {
    throw new Error(`Room codes contain ${WATCH_TOGETHER_CODE_LENGTH} letters or numbers.`);
  }
  return code;
}

export function normalizeParticipantName(value) {
  const name = String(value || "").trim();
  if (!name || name.length > 50 || /[\r\n\0]/.test(name)) {
    throw new Error("Participant names must contain 1 to 50 characters.");
  }
  return name;
}

function positiveInteger(value, label, { allowZero = false } = {}) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < (allowZero ? 0 : 1)) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return number;
}

export function normalizeMediaIdentity(value) {
  const mediaType = value?.mediaType === "show" ? "tv" : value?.mediaType;
  if (!new Set(["movie", "tv"]).has(mediaType)) {
    throw new Error("Watch Together supports movies and TV episodes.");
  }
  const media = {
    mediaType,
    tmdbId: positiveInteger(value?.tmdbId, "TMDB ID"),
  };
  if (mediaType === "tv") {
    media.seasonNumber = positiveInteger(value?.seasonNumber, "Season number", { allowZero: true });
    media.episodeNumber = positiveInteger(value?.episodeNumber, "Episode number");
  }
  return media;
}

export function mediaIdentityKey(value) {
  const media = normalizeMediaIdentity(value);
  return [media.mediaType, media.tmdbId, media.seasonNumber ?? "", media.episodeNumber ?? ""].join(":");
}

export function sameMediaIdentity(left, right) {
  try { return mediaIdentityKey(left) === mediaIdentityKey(right); }
  catch { return false; }
}

export function mediaIdentityHref(value) {
  const media = normalizeMediaIdentity(value);
  if (media.mediaType === "movie") return `/movies/${media.tmdbId}`;
  const params = new URLSearchParams({
    season: String(media.seasonNumber),
    episode: String(media.episodeNumber),
  });
  return `/shows/${media.tmdbId}?${params}`;
}

export function validatePublicRoomPayload(value, path = "message") {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (/(?:\bmagnet:|\bhttps?:\/\/|\/api\/torrents\/|\/api\/playback\/debrid)/i.test(value)) {
      throw new Error(`${path} contains private playback data.`);
    }
    return value;
  }
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) {
    value.forEach((item, index) => validatePublicRoomPayload(item, `${path}[${index}]`));
    return value;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) throw new Error(`${path}.${key} is not allowed.`);
    validatePublicRoomPayload(nested, `${path}.${key}`);
  }
  return value;
}

export function normalizeStunUrls(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(",");
  const urls = [...new Set(values.map((item) => String(item).trim()).filter(Boolean))];
  if (!urls.length || urls.some((url) => !/^stuns?:[^\s]+$/i.test(url))) {
    throw new Error("STUN servers must use stun: or stuns: URLs.");
  }
  return urls;
}
