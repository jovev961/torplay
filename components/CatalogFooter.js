"use client";

import { useI18n } from "./I18nProvider.js";

export default function CatalogFooter() {
  const { t } = useI18n();
  return (
    <footer className="credits">
      <div className="tmdbMark" aria-label="TMDB">TMDB</div>
      <p>{t("This product uses the TMDB API but is not endorsed or certified by TMDB.")}</p>
      <p>{t("Use TorPlay only with public-domain, Creative Commons, or otherwise authorized content.")}</p>
    </footer>
  );
}
