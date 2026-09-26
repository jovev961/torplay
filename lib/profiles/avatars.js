const LEGACY_AVATAR_IDS = Object.freeze({
  ember: "cinema-dog.png",
  ocean: "friendly-robot.png",
  violet: "fox.png",
  solar: "black-cat.png",
  mint: "owl.png",
  rose: "panda.png",
  sky: "raccoon.png",
  slate: "curious-robot.png",
});

const AVATAR_FILE = /^[a-z0-9][a-z0-9._-]*\.(?:avif|jpe?g|png|webp)$/i;

export const DEFAULT_PROFILE_AVATAR_ID = "cinema-dog.png";

export function normalizeProfileAvatarId(value) {
  const id = typeof value === "string" ? value.trim() : "";
  if (LEGACY_AVATAR_IDS[id]) return LEGACY_AVATAR_IDS[id];
  return AVATAR_FILE.test(id) ? id : "";
}

export function profileAvatarSrc(id) {
  const normalized = normalizeProfileAvatarId(id) || DEFAULT_PROFILE_AVATAR_ID;
  return `/profilePictures/${encodeURIComponent(normalized)}`;
}
