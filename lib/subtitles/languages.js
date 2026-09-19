import { subtitleConfig } from "./config.js";
import { normalizeSubtitleLanguage } from "./preferences.js";

const OPEN_SUBTITLES_LANGUAGES_URL = "https://api.opensubtitles.com/api/v1/infos/languages";
const SUBDL_LANGUAGES_URL = "https://subdl.com/api-files/language_list.json";
const REMOTE_CACHE_MS = 24 * 60 * 60 * 1_000;
const FALLBACK_CACHE_MS = 5 * 60 * 1_000;
const REQUEST_TIMEOUT_MS = 5_000;

export const BUNDLED_SUBTITLE_LANGUAGES = Object.freeze([
  ["af", "Afrikaans"], ["sq", "Albanian"], ["ar", "Arabic"],
  ["hy", "Armenian"], ["eu", "Basque"], ["be", "Belarusian"],
  ["bn", "Bengali"], ["bs", "Bosanski"], ["bg", "Bulgarian"],
  ["my", "Burmese"], ["ca", "Catalan"], ["zh-cn", "Chinese (Simplified)"],
  ["zh-tw", "Chinese (Traditional)"], ["hr", "Hrvatski"], ["cs", "Czech"],
  ["da", "Danish"], ["nl", "Dutch"], ["en", "English"],
  ["eo", "Esperanto"], ["et", "Estonian"], ["fi", "Finnish"],
  ["fr", "French"], ["gl", "Galician"], ["ka", "Georgian"],
  ["de", "German"], ["el", "Greek"], ["he", "Hebrew"],
  ["hi", "Hindi"], ["hu", "Hungarian"], ["is", "Icelandic"],
  ["id", "Indonesian"], ["it", "Italian"], ["ja", "Japanese"],
  ["kk", "Kazakh"], ["km", "Khmer"], ["ko", "Korean"],
  ["lv", "Latvian"], ["lt", "Lithuanian"], ["lb", "Luxembourgish"],
  ["mk", "Македонски"], ["ms", "Malay"], ["ml", "Malayalam"],
  ["mn", "Mongolian"], ["me", "Montenegrin"], ["no", "Norwegian"],
  ["fa", "Persian"], ["pl", "Polish"], ["pt-pt", "Portuguese"],
  ["pt-br", "Portuguese (Brazilian)"], ["ro", "Romanian"], ["ru", "Russian"],
  ["sr", "Српски"], ["si", "Sinhalese"], ["sk", "Slovak"],
  ["sl", "Slovenian"], ["es", "Spanish"], ["sw", "Swahili"],
  ["sv", "Swedish"], ["ta", "Tamil"], ["te", "Telugu"],
  ["tl", "Tagalog"], ["th", "Thai"], ["tr", "Turkish"],
  ["uk", "Ukrainian"], ["ur", "Urdu"], ["uz", "Uzbek"],
  ["vi", "Vietnamese"],
].map(([code, label]) => Object.freeze({ code, label })));

const bundledLabels = new Map(BUNDLED_SUBTITLE_LANGUAGES.map(({ code, label }) => [code, label]));
let cachedCatalog = null;

function normalizeEntry(codeValue, labelValue) {
  try {
    const code = normalizeSubtitleLanguage(codeValue);
    const label = typeof labelValue === "string" ? labelValue.trim() : "";
    return { code, label: label || bundledLabels.get(code) || code.toUpperCase() };
  } catch {
    return null;
  }
}

function normalizeCatalog(entries) {
  const languages = new Map();
  for (const entry of entries) {
    if (!entry) continue;
    const normalized = normalizeEntry(
      entry.language_code ?? entry.code ?? entry.id ?? entry.key,
      entry.language_name ?? entry.name ?? entry.label ?? entry.value,
    );
    if (normalized && !languages.has(normalized.code)) languages.set(normalized.code, normalized);
  }
  return [...languages.values()].sort((left, right) =>
    left.label.localeCompare(right.label) || left.code.localeCompare(right.code));
}

function entriesFromPayload(payload) {
  const value = payload?.data ?? payload?.languages ?? payload;
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    return Object.entries(value).map(([code, label]) => (
      label && typeof label === "object" ? { code, ...label } : { code, label }
    ));
  }
  return [];
}

async function requestCatalog(url, headers, fetchImpl) {
  const response = await fetchImpl(url, {
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Language provider returned HTTP ${response.status}.`);
  const languages = normalizeCatalog(entriesFromPayload(await response.json()));
  if (languages.length === 0) throw new Error("Language provider returned no usable languages.");
  return languages;
}

export async function getSubtitleLanguageCatalog({
  config = subtitleConfig(),
  fetchImpl = fetch,
  now = Date.now(),
  useCache = fetchImpl === fetch,
} = {}) {
  if (useCache && cachedCatalog?.expiresAt > now) return cachedCatalog.value;

  const openHeaders = {
    Accept: "application/json",
    "User-Agent": config.opensubtitles.userAgent,
  };
  if (config.opensubtitles.apiKey) openHeaders["Api-Key"] = config.opensubtitles.apiKey;

  let value;
  try {
    value = {
      source: "opensubtitles",
      languages: await requestCatalog(OPEN_SUBTITLES_LANGUAGES_URL, openHeaders, fetchImpl),
    };
  } catch {
    try {
      value = {
        source: "subdl",
        languages: await requestCatalog(SUBDL_LANGUAGES_URL, { Accept: "application/json" }, fetchImpl),
      };
    } catch {
      value = { source: "bundled", languages: normalizeCatalog(BUNDLED_SUBTITLE_LANGUAGES) };
    }
  }

  if (useCache) {
    cachedCatalog = {
      expiresAt: now + (value.source === "bundled" ? FALLBACK_CACHE_MS : REMOTE_CACHE_MS),
      value,
    };
  }
  return value;
}

export function resetSubtitleLanguageCatalogCache() {
  cachedCatalog = null;
}

export function bundledSubtitleLanguageLabel(language) {
  return bundledLabels.get(language) || String(language || "").toUpperCase();
}
