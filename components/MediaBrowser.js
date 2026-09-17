import Image from "next/image";
import Link from "next/link";
import { mediaDetailsHref } from "../lib/metadata/catalog.js";

export function MediaCard({ item }) {
  return (
    <Link className="mediaCard" href={mediaDetailsHref(item)}>
      <div className="posterFrame">
        {item.posterUrl ? (
          <Image src={item.posterUrl} alt="" fill sizes="(max-width: 640px) 42vw, 190px" />
        ) : (
          <div className="imageFallback" aria-hidden="true">{item.title?.slice(0, 1) || "?"}</div>
        )}
        <span className="mediaTypeBadge">{item.mediaType === "movie" ? "Movie" : "TV Show"}</span>
      </div>
      <div className="cardCopy">
        <h3>{item.title}</h3>
        <span>{item.year || "Date unavailable"}</span>
      </div>
    </Link>
  );
}

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
        <div className="posterRow">
          {items.map((item) => <MediaCard item={item} key={`${item.mediaType}-${item.id}`} />)}
        </div>
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
