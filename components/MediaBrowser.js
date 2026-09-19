import ImdbRatedCards from "./ImdbRatedCards.js";

export function MediaShelf({ title, items, error }) {
  const headingId = `${title.replace(/\s+/g, "-").toLowerCase()}-heading`;
  return (
    <section className="mediaShelf" aria-labelledby={headingId}>
      <div className="shelfHeading">
        <h2 id={headingId}>{title}</h2>
        <span>{items.length ? `${items.length} titles` : ""}</span>
      </div>
      {error ? <div className="notice error">{error}</div> : null}
      {!error && items.length === 0 ? <div className="notice">No titles available.</div> : null}
      {items.length > 0 ? (
        <ImdbRatedCards className="posterRow" items={items} />
      ) : null}
    </section>
  );
}

export default function MediaBrowser({ movies, shows, movieError, showError }) {
  return (
    <div className="catalog">
      <MediaShelf title="Trending Movies" items={movies} error={movieError} />
      <MediaShelf title="Trending Shows" items={shows} error={showError} />
    </div>
  );
}
