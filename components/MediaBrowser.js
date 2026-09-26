"use client";

import ImdbRatedCards from "./ImdbRatedCards.js";
import { useI18n } from "./I18nProvider.js";

export function MediaShelf({ title, items, error }) {
  const { t } = useI18n();
  const headingId = `${title.replace(/\s+/g, "-").toLowerCase()}-heading`;
  return (
    <section className="mediaShelf" aria-labelledby={headingId}>
      <div className="shelfHeading">
        <h2 id={headingId}>{t(title)}</h2>
        <span>{items.length ? t(`${items.length} titles`) : ""}</span>
      </div>
      {error ? <div className="notice error">{error}</div> : null}
      {!error && items.length === 0 ? <div className="notice">{t("No titles available.")}</div> : null}
      {items.length > 0 ? (
        <ImdbRatedCards className="posterRow" items={items} />
      ) : null}
    </section>
  );
}

export default function MediaBrowser({ movies, shows, movieError, showError, children }) {
  return (
    <div className="catalog">
      {children}
      <MediaShelf title="Trending Movies" items={movies} error={movieError} />
      <MediaShelf title="Trending Shows" items={shows} error={showError} />
    </div>
  );
}
