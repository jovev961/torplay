import { defaultSubtitlePreferences } from "./preferences.js";

function positiveNumber(value, fallback, name) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number.`);
  return parsed;
}

export function subtitleConfig(env = process.env) {
  const { defaultLanguage, enabledLanguages } = defaultSubtitlePreferences();
  const cachePath = String(env.SUBTITLE_CACHE_PATH || ".data/subtitles").trim();
  if (!cachePath) throw new Error("SUBTITLE_CACHE_PATH must not be empty.");

  return {
    defaultLanguage,
    enabledLanguages,
    cachePath,
    cacheTtlDays: positiveNumber(
      env.SUBTITLE_CACHE_TTL_DAYS,
      30,
      "SUBTITLE_CACHE_TTL_DAYS",
    ),
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

export function subtitleLanguageLabel(language) {
  const labels = new Intl.DisplayNames(["en"], { type: "language" });
  try {
    return labels.of(language) || language.toUpperCase();
  } catch {
    return language.toUpperCase();
  }
}
