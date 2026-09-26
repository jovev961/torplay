"use client";

import Link from "next/link";
import { catalogHref } from "../lib/metadata/catalog.js";
import ImdbRatedCards from "./ImdbRatedCards.js";
import { useI18n } from "./I18nProvider.js";

export default function CatalogResults({ pathname, result, state, emptyMessage }) {
  const { formatNumber, t } = useI18n();
  const countLabel = result.totalsExact
    ? `${formatNumber(result.totalResults)} ${t(result.totalResults === 1 ? "title" : "titles")}`
    : t("{count} matching on this provider page", { count: result.results.length });

  return (
    <section className="catalogResults" aria-labelledby="results-heading">
      <div className="shelfHeading">
        <h2 id="results-heading">{t("Results")}</h2>
        <span>{countLabel}</span>
      </div>
      {result.results.length === 0 ? <div className="notice">{emptyMessage}</div> : (
        <ImdbRatedCards className="mediaGrid" items={result.results} />
      )}
      {(result.hasPreviousPage || result.hasNextPage) ? (
        <nav className="pagination" aria-label={t("Results pages")}>
          {result.hasPreviousPage ? (
            <Link className="secondaryButton" href={catalogHref(pathname, { ...state, page: result.page - 1 })}>
              {t("← Previous")}
            </Link>
          ) : <span />}
          <span>{t(result.totalPages ? `Page ${result.page} of ${result.totalPages}` : `Page ${result.page}`)}</span>
          {result.hasNextPage ? (
            <Link className="secondaryButton" href={catalogHref(pathname, { ...state, page: result.page + 1 })}>
              {t("Next →")}
            </Link>
          ) : <span />}
        </nav>
      ) : null}
      {!result.totalsExact ? (
        <p className="catalogNote">
          {t("TMDB does not support genre filters in title search. Genre matching is applied to this search page, so later pages can contain additional matches.")}
        </p>
      ) : null}
    </section>
  );
}
