import Image from "next/image";
import Link from "next/link";
import { formatImdbRating } from "../lib/metadata/imdb-display.js";
import { mediaDetailsHref } from "../lib/metadata/catalog.js";

export default function MediaCard({ item, imdbRating = null }) {
  const formattedRating = formatImdbRating(imdbRating);
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
        <div className="cardMetaRow">
          <span>{item.year || "Date unavailable"}</span>
          {formattedRating ? (
            <span className="imdbRating" aria-label={`IMDb rating ${formattedRating} out of 10`}>
              <span aria-hidden="true">★</span> {formattedRating} <small>IMDb</small>
            </span>
          ) : null}
        </div>
      </div>
    </Link>
  );
}
