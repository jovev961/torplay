import { readdirSync } from "node:fs";
import path from "node:path";
import {
  DEFAULT_PROFILE_AVATAR_ID,
  normalizeProfileAvatarId,
  profileAvatarSrc,
} from "./avatars.js";

const PROFILE_PICTURES_DIRECTORY = path.join(process.cwd(), "public", "profilePictures");
const SUPPORTED_EXTENSION = /\.(?:avif|jpe?g|png|webp)$/i;

function avatarLabel(filename) {
  return path.basename(filename, path.extname(filename))
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export function listProfileAvatars(directory = PROFILE_PICTURES_DIRECTORY) {
  let files = [];
  try {
    files = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && SUPPORTED_EXTENSION.test(entry.name))
      .map((entry) => entry.name);
  } catch {}
  return files
    .sort((left, right) => left.localeCompare(right))
    .map((id) => ({ id, label: avatarLabel(id), src: profileAvatarSrc(id) }));
}

export function isProfileAvatarId(value) {
  const id = normalizeProfileAvatarId(value);
  return Boolean(id && listProfileAvatars().some((avatar) => avatar.id === id));
}

export function defaultProfileAvatarId(seed = "", offset = 0) {
  const avatars = listProfileAvatars();
  if (!avatars.length) return DEFAULT_PROFILE_AVATAR_ID;
  const hash = [...String(seed)].reduce(
    (total, character) => ((total * 31) + character.codePointAt(0)) >>> 0,
    offset >>> 0,
  );
  return avatars[hash % avatars.length].id;
}

export function availableProfileAvatarId(value, seed = "") {
  const normalized = normalizeProfileAvatarId(value);
  return isProfileAvatarId(normalized) ? normalized : defaultProfileAvatarId(seed);
}
