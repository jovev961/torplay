"use client";

import { useI18n } from "./I18nProvider.js";

export default function LanguageSwitcher({ className = "" }) {
  const { locale, setLocale, t } = useI18n();
  return (
    <div className={`languageSwitcher ${className}`.trim()} role="group" aria-label={t("Change language")}>
      <button type="button" aria-pressed={locale === "en"} title={t("English")} onClick={() => setLocale("en")}>EN</button>
      <span aria-hidden="true">/</span>
      <button type="button" aria-pressed={locale === "mk"} title={t("Macedonian")} onClick={() => setLocale("mk")}>МК</button>
    </div>
  );
}
