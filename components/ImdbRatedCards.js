"use client";

import { useEffect, useMemo, useState } from "react";
import MediaCard from "./MediaCard.js";

const pendingRequests = new Map();

function mediaIdentity(item) {
  return `${item.mediaType}:${item.id}`;
}

function loadRatings(items) {
  const requestItems = items.map((item) => ({ mediaType: item.mediaType, tmdbId: item.id }));
  const requestKey = requestItems.map((item) => `${item.mediaType}:${item.tmdbId}`).sort().join("|");
  if (!pendingRequests.has(requestKey)) {
    const request = fetch("/api/metadata/imdb-ratings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: requestItems }),
    }).then(async (response) => {
      if (!response.ok) throw new Error("IMDb ratings are unavailable.");
      return response.json();
    }).finally(() => pendingRequests.delete(requestKey));
    pendingRequests.set(requestKey, request);
  }
  return pendingRequests.get(requestKey);
}

export default function ImdbRatedCards({ items, className }) {
  const [ratings, setRatings] = useState({});
  const identity = useMemo(() => items.map(mediaIdentity).join("|"), [items]);

  useEffect(() => {
    let cancelled = false;
    if (!items.length) return () => { cancelled = true; };
    void loadRatings(items).then((data) => {
      if (cancelled) return;
      setRatings(Object.fromEntries((data.ratings || []).map((item) => [
        `${item.mediaType}:${item.tmdbId}`,
        item.imdbRating,
      ])));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [identity, items]);

  return (
    <div className={className}>
      {items.map((item) => (
        <MediaCard
          item={item}
          imdbRating={ratings[mediaIdentity(item)]}
          key={mediaIdentity(item)}
        />
      ))}
    </div>
  );
}
