export const PROFILE_AVATARS = Object.freeze([
  { id: "ember", label: "Ember", symbol: "▶" },
  { id: "ocean", label: "Ocean", symbol: "≋" },
  { id: "violet", label: "Violet", symbol: "✦" },
  { id: "solar", label: "Solar", symbol: "☀" },
  { id: "mint", label: "Orbit", symbol: "◎" },
  { id: "rose", label: "Prism", symbol: "◆" },
  { id: "sky", label: "Comet", symbol: "☄" },
  { id: "slate", label: "Peak", symbol: "▲" },
]);

export const DEFAULT_PROFILE_AVATAR_ID = PROFILE_AVATARS[0].id;

export function isProfileAvatarId(value) {
  return PROFILE_AVATARS.some((avatar) => avatar.id === value);
}

export function defaultProfileAvatarId(seed = "", offset = 0) {
  const hash = [...String(seed)].reduce(
    (total, character) => ((total * 31) + character.codePointAt(0)) >>> 0,
    offset >>> 0,
  );
  return PROFILE_AVATARS[hash % PROFILE_AVATARS.length].id;
}

export function profileAvatar(id) {
  return PROFILE_AVATARS.find((avatar) => avatar.id === id) || PROFILE_AVATARS[0];
}
