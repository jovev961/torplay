"use client";

import { useEffect, useState } from "react";

function progressParams(media) {
  const params = new URLSearchParams({ mediaType: media.mediaType, tmdbId: String(media.tmdbId) });
  if (media.mediaType === "tv") {
    params.set("seasonNumber", String(media.seasonNumber));
    params.set("episodeNumber", String(media.episodeNumber));
  }
  return params.toString();
}

export default function useSavedProgress(profileId, media) {
  const identity = profileId && media
    ? `${profileId}:${media.mediaType}:${media.tmdbId}:${media.seasonNumber ?? -1}:${media.episodeNumber ?? -1}`
    : "";
  const query = media ? progressParams(media) : "";
  const [state, setState] = useState({ identity: "", loading: false, progress: null, error: "" });

  useEffect(() => {
    if (!profileId || !media) return undefined;
    let cancelled = false;
    void fetch(`/api/profiles/${encodeURIComponent(profileId)}/progress?${query}`, { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Progress is unavailable.");
        if (!cancelled) setState({ identity, loading: false, progress: data.progress, error: "" });
      })
      .catch((error) => { if (!cancelled) setState({ identity, loading: false, progress: null, error: error.message }); });
    return () => { cancelled = true; };
  }, [identity, media, profileId, query]);

  return state.identity === identity ? state : { loading: true, progress: null, error: "" };
}
