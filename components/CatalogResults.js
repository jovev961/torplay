import Link from "next/link";
import { catalogHref } from "../lib/metadata/catalog.js";
import { MediaCard } from "./MediaBrowser.js";

export default function CatalogResults({ pathname, result, state, emptyMessage }) {
  const countLabel = result.totalsExact
    ? `${result.totalResults.toLocaleString()} ${result.totalResults === 1 ? "title" : "titles"}`
    : `${result.results.length} matching on this provider page`;

  return (
    <section className="catalogResults" aria-labelledby="results-heading">
      <div className="shelfHeading">
        <h2 id="results-heading">Results</h2>
        <span>{countLabel}</span>
      </div>
      {result.results.length === 0 ? <div className="notice">{emptyMessage}</div> : (
        <div className="mediaGrid">
          {result.results.map((item) => (
            <MediaCard item={item} key={`${item.mediaType}-${item.id}`} />
          ))}
        </div>
      )}
      {(result.hasPreviousPage || result.hasNextPage) ? (
        <nav className="pagination" aria-label="Results pages">
          {result.hasPreviousPage ? (
            <Link className="secondaryButton" href={catalogHref(pathname, { ...state, page: result.page - 1 })}>
              ← Previous
            </Link>
          ) : <span />}
          <span>Page {result.page}{result.totalPages ? ` of ${result.totalPages}` : ""}</span>
          {result.hasNextPage ? (
            <Link className="secondaryButton" href={catalogHref(pathname, { ...state, page: result.page + 1 })}>
              Next →
            </Link>
          ) : <span />}
        </nav>
      ) : null}
      {!result.totalsExact ? (
        <p className="catalogNote">
          TMDB does not support genre filters in title search. Genre matching is applied to this search page,
          so later pages can contain additional matches.
        </p>
      ) : null}
    </section>
  );
}
