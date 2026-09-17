const DEFAULT_LANGUAGES = ["en", "mk", "sr", "hr", "bs"];
const LANGUAGE_PATTERN = /^[a-z]{2,3}(?:-[a-z]{2})?$/i;

function languages(value) {
  const parsed = [...new Set(
    String(value ?? "")
      .split(",")
      .map((language) => language.trim().toLowerCase())
      .filter(Boolean),
  )];
  if (parsed.length === 0) return [...DEFAULT_LANGUAGES];
  if (parsed.some((language) => !LANGUAGE_PATTERN.test(language))) {
    throw new Error("SUBTITLE_LANGUAGES contains an invalid language code.");
  }
  return parsed;
}

function positiveNumber(value, fallback, name) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number.`);
  return parsed;
}

export function subtitleConfig(env = process.env) {
  const enabledLanguages = languages(env.SUBTITLE_LANGUAGES);
  const defaultLanguage = String(env.SUBTITLE_DEFAULT_LANGUAGE || "en").trim().toLowerCase();
  if (!enabledLanguages.includes(defaultLanguage)) {
    throw new Error("SUBTITLE_DEFAULT_LANGUAGE must be included in SUBTITLE_LANGUAGES.");
  }

  return {
    defaultLanguage,
    enabledLanguages,
    cachePath: String(env.SUBTITLE_CACHE_PATH || ".data/subtitles").trim(),
    opensubtitles: {
      apiKey: env.OPENSUBTITLES_API_KEY?.trim() || null,
      userAgent: env.OPENSUBTITLES_USER_AGENT?.trim() || "TorPlay v0.1",
    },
    subdl: {
      apiKey: env.SUBDL_API_KEY?.trim() || null,
    },
    bufferAheadSeconds: positiveNumber(
      env.PLAYBACK_BUFFER_AHEAD_SECONDS,
      60,
      "PLAYBACK_BUFFER_AHEAD_SECONDS",
    ),
  };
}

export const SUBTITLE_LANGUAGE_LABELS = new Map([
  ["en", "English"],
  ["mk", "Македонски"],
  ["sr", "Српски"],
  ["hr", "Hrvatski"],
  ["bs", "Bosanski"],
]);

export function subtitleLanguageLabel(language) {
  return SUBTITLE_LANGUAGE_LABELS.get(language) || language.toUpperCase();
}
