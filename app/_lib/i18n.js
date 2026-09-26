import { cookies } from "next/headers";
import { createTranslator } from "../../lib/i18n/index.js";
import { LOCALE_COOKIE, normalizeLocale } from "../../lib/i18n/locales.js";

export async function getServerLocale() {
  const store = await cookies();
  return normalizeLocale(store.get(LOCALE_COOKIE)?.value);
}

export async function getServerI18n() {
  const locale = await getServerLocale();
  return { locale, t: createTranslator(locale) };
}
