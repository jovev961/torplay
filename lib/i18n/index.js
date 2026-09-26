import { DEFAULT_LOCALE, normalizeLocale } from "./locales.js";
import { macedonianMessage } from "./messages.js";

export function translate(locale, message, values = {}) {
  const source = String(message ?? "");
  const template = normalizeLocale(locale) === "mk" ? macedonianMessage(source) : source;
  return template.replace(/\{(\w+)\}/g, (match, name) => (
    Object.hasOwn(values, name) ? String(values[name]) : match
  ));
}

export function createTranslator(locale = DEFAULT_LOCALE) {
  const normalized = normalizeLocale(locale);
  return (message, values) => translate(normalized, message, values);
}

export function formatNumber(locale, value, options) {
  return new Intl.NumberFormat(normalizeLocale(locale) === "mk" ? "mk-MK" : "en-US", options).format(value);
}

export function formatDate(locale, value, options = { dateStyle: "medium" }) {
  return new Intl.DateTimeFormat(normalizeLocale(locale) === "mk" ? "mk-MK" : "en-US", options).format(value);
}

export function displayLanguage(locale, code) {
  try {
    return new Intl.DisplayNames([normalizeLocale(locale) === "mk" ? "mk" : "en"], { type: "language" }).of(code) || code;
  } catch {
    return code;
  }
}
