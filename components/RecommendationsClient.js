"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import ImdbRatedCards from "./ImdbRatedCards.js";
import MediaCard from "./MediaCard.js";
import { useProfile } from "./ProfileProvider.js";
import { catalogHref, filterRecommendationItems } from "../lib/metadata/catalog.js";

export default function RecommendationsClient({ mode, shelf = false, type = "all", genre = null }) {
  const { activeProfile } = useProfile();
  const profileId = activeProfile?.id;
  const requestKey = profileId ? `${profileId}:${mode}` : null;
  const [state, setState] = useState({ key: null, result: null, error: "" });

  useEffect(() => {
    if (!profileId) return undefined;
    const controller = new AbortController();
    void fetch(`/api/profiles/${encodeURIComponent(profileId)}/recommendations?mode=${mode}`, {
      cache: "no-store",
      signal: controller.signal,
    }).then(async (response) => {
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || "Recommendations are unavailable.");
      return data;
    }).then((result) => {
      if (!controller.signal.aborted) setState({ key: requestKey, result, error: "" });
    }).catch((error) => {
      if (!controller.signal.aborted) setState({ key: requestKey, result: null, error: error.message });
    });
    return () => controller.abort();
  }, [profileId, mode, requestKey]);

  if (!profileId) return null;
  const loaded = state.key === requestKey;
  const result = loaded ? state.result : null;
  const error = loaded ? state.error : "";
  const filteredResults = result
    ? filterRecommendationItems(result.results, { type, genre })
    : [];

  if (shelf) {
    if (loaded && !error && !result?.results.length) return null;
    return (
      <section className="mediaShelf" aria-labelledby="home-recommendations-heading">
        <div className="shelfHeading">
          <h2 id="home-recommendations-heading">Recommended for You</h2>
          <Link className="inlineLink" href="/recommendations">See all →</Link>
        </div>
        {!loaded ? <div className="notice" role="status">Finding recommendations…</div> : null}
        {error ? <div className="notice error" role="alert">{error}</div> : null}
        {result?.results.length ? <ImdbRatedCards className="posterRow" items={result.results.slice(0, 20)} /> : null}
      </section>
    );
  }

  return (
    <section className="catalogResults" aria-labelledby="recommendations-heading">
      <div className="shelfHeading recommendationsHeading">
        <div>
          <h2 id="recommendations-heading">{mode === "all" ? "All recommendations" : "Based on what you’ve watched"}</h2>
          <p>{mode === "all" ? "Suggestions from up to 30 watched titles." : "Suggestions from your 10 most recently watched titles."}</p>
        </div>
        <Link className="secondaryButton" href={catalogHref("/recommendations", {
          mode: mode === "all" ? "recent" : "all",
          type,
          genre: genre?.slug || "",
        })}>
          {mode === "all" ? "Recent recommendations" : "All Recommendations"}
        </Link>
      </div>
      {!loaded ? <div className="notice" role="status">Finding recommendations…</div> : null}
      {error ? <div className="notice error" role="alert">{error}</div> : null}
      {result?.partial ? <div className="notice">Some sources were unavailable; showing the recommendations we found.</div> : null}
      {result?.seedCount === 0 ? (
        <div className="notice">Watch a movie or an episode first, then come back for recommendations. <Link className="inlineLink" href="/discover">Explore titles</Link></div>
      ) : result && filteredResults.length === 0 ? (
        <div className="notice">No recommendations match these filters. Try another media type or genre, or <Link className="inlineLink" href="/discover">explore titles</Link>.</div>
      ) : result ? (
        <div className="mediaGrid">{filteredResults.map((item) => <MediaCard item={item} key={`${item.mediaType}:${item.id}`} />)}</div>
      ) : null}
    </section>
  );
}
