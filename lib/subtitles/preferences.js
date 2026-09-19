export const DEFAULT_SUBTITLE_PREFERENCES = Object.freeze({
  defaultLanguage: "en",
  enabledLanguages: Object.freeze(["en", "mk", "sr", "hr", "bs"]),
});

export const SUBTITLE_LANGUAGE_PATTERN = /^[a-z]{2,3}(?:-[a-z]{2})?$/i;

export function normalizeSubtitleLanguage(value) {
  const language = typeof value === "string" ? value.trim().toLowerCase().replaceAll("_", "-") : "";
  if (!SUBTITLE_LANGUAGE_PATTERN.test(language)) {
    throw new Error("Subtitle languages must use valid two- or three-letter language codes.");
  }
  return language;
}

export function normalizeSubtitlePreferences(input) {
  if (!Array.isArray(input?.enabledLanguages)) {
    throw new Error("Choose at least one subtitle language.");
  }
  const enabledLanguages = [...new Set(input.enabledLanguages.map(normalizeSubtitleLanguage))];
  if (enabledLanguages.length === 0) throw new Error("Choose at least one subtitle language.");
  const defaultLanguage = normalizeSubtitleLanguage(input?.defaultLanguage);
  if (!enabledLanguages.includes(defaultLanguage)) {
    throw new Error("The primary subtitle language must also be enabled.");
  }
  return { defaultLanguage, enabledLanguages };
}

export function defaultSubtitlePreferences() {
  return {
    defaultLanguage: DEFAULT_SUBTITLE_PREFERENCES.defaultLanguage,
    enabledLanguages: [...DEFAULT_SUBTITLE_PREFERENCES.enabledLanguages],
  };
}

export function legacySubtitlePreferences(env = process.env) {
  const configured = String(env.SUBTITLE_LANGUAGES || "").split(",").filter((value) => value.trim());
  if (configured.length === 0 && !env.SUBTITLE_DEFAULT_LANGUAGE) return defaultSubtitlePreferences();
  try {
    return normalizeSubtitlePreferences({
      defaultLanguage: env.SUBTITLE_DEFAULT_LANGUAGE || "en",
      enabledLanguages: configured.length ? configured : DEFAULT_SUBTITLE_PREFERENCES.enabledLanguages,
    });
  } catch {
    return defaultSubtitlePreferences();
  }
}

export function sameSubtitlePreferences(left, right) {
  return left?.defaultLanguage === right?.defaultLanguage
    && left?.enabledLanguages?.length === right?.enabledLanguages?.length
    && left.enabledLanguages.every((language, index) => language === right.enabledLanguages[index]);
}
