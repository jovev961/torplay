export const ORIGINAL_AUDIO_LANGUAGE = "original";

export function normalizeAudioLanguage(value) {
  const input = typeof value === "string" ? value.trim().toLowerCase().replaceAll("_", "-") : "";
  if (!input || input === "und") return "und";
  try {
    const language = new Intl.Locale(input).language.toLowerCase();
    return /^[a-z]{2,3}$/.test(language) ? language : "und";
  } catch {
    return "und";
  }
}

export function normalizeAudioPreference(value) {
  const input = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!input || input === ORIGINAL_AUDIO_LANGUAGE) return ORIGINAL_AUDIO_LANGUAGE;
  if (!/^[a-z]{2,3}$/i.test(input)) throw new Error("Choose a valid preferred audio language.");
  const language = normalizeAudioLanguage(input);
  if (language === "und") throw new Error("Choose a valid preferred audio language.");
  return language;
}

export function isSpecialAudioTrack(track) {
  return Boolean(track?.commentary || track?.audioDescription);
}

function defaultFirst(tracks) {
  return tracks.find((track) => track.default) || tracks[0] || null;
}

export function selectAudioTrack(tracks, preferredLanguage = ORIGINAL_AUDIO_LANGUAGE) {
  const available = Array.isArray(tracks) ? tracks : [];
  if (!available.length) return null;
  const normal = available.filter((track) => !isSpecialAudioTrack(track));
  let preference = ORIGINAL_AUDIO_LANGUAGE;
  try { preference = normalizeAudioPreference(preferredLanguage); } catch {}
  if (preference !== ORIGINAL_AUDIO_LANGUAGE) {
    const matching = normal.filter((track) => track.language === preference);
    if (matching.length) return defaultFirst(matching);
  }
  return defaultFirst(normal) || defaultFirst(available);
}

export function audioTrackByIndex(tracks, value) {
  const index = Number(value);
  if (!Number.isInteger(index) || index < 0) return null;
  return (Array.isArray(tracks) ? tracks : []).find((track) => track.index === index) || null;
}
