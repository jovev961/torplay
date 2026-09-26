export const DEFAULT_LOCALE = "en";
export const SUPPORTED_LOCALES = ["en", "mk"];
export const LOCALE_COOKIE = "torplay_locale";

export function normalizeLocale(value) {
  const candidate = String(value || "").trim().toLowerCase().split(/[-_]/)[0];
  return SUPPORTED_LOCALES.includes(candidate) ? candidate : DEFAULT_LOCALE;
}

export function tmdbLocale(locale) {
  return normalizeLocale(locale) === "mk" ? "mk-MK" : "en-US";
}

export function localeFromRequest(request) {
  const cookie = request?.headers?.get?.("cookie") || "";
  const value = cookie.split(";").map((item) => item.trim())
    .find((item) => item.startsWith(`${LOCALE_COOKIE}=`))?.slice(LOCALE_COOKIE.length + 1);
  return normalizeLocale(value ? decodeURIComponent(value) : "");
}
