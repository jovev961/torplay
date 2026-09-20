"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import SourcePanel from "./SourcePanel.js";
import { useSourceLookup } from "./useSourceLookup.js";
import useSavedProgress from "./useSavedProgress.js";
import { useProfile } from "./ProfileProvider.js";
import { formatPlaybackTime } from "../lib/history/presentation.js";

export default function MovieSource({ movie, initialIntent = null }) {
  const { activeProfile } = useProfile();
  const lookup = useSourceLookup();
  const workspaceRef = useRef(null);
  const [intent, setIntent] = useState(initialIntent);
  const media = useMemo(() => ({
    mediaType: "movie",
    tmdbId: movie.id,
    title: movie.title,
    posterUrl: movie.posterUrl,
    backdropUrl: movie.backdropUrl,
  }), [movie]);
  const saved = useSavedProgress(activeProfile?.id, media);
  const resumable = saved.progress && !saved.progress.completed && saved.progress.position >= 30;

  useEffect(() => {
    if (lookup.session?.id) {
      workspaceRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [lookup.session?.id]);

  async function findSources(nextIntent) {
    setIntent(nextIntent);
    await lookup.search({
      type: "movie",
      query: movie.title,
      tmdbId: movie.id,
      imdbId: movie.imdbId,
      year: movie.year,
    });
  }

  return (
    <div className="sourceWorkspace" ref={workspaceRef}>
      {!lookup.hasSearched ? (
        <div className="resumeActions">
          {resumable ? <button className="primaryButton" type="button" onClick={() => void findSources("resume")}>Resume from {formatPlaybackTime(saved.progress.position)}</button> : null}
          <button className={resumable ? "secondaryButton" : "primaryButton"} type="button" onClick={() => void findSources("start")}>
            {saved.progress ? "Start from beginning" : "Find authorized sources"}
          </button>
          {saved.error ? <span className="muted">Progress unavailable; playback still works.</span> : null}
        </div>
      ) : null}
      {lookup.hasSearched ? (
        <SourcePanel
          lookup={lookup}
          heading={`Sources for ${movie.title}`}
          playerTitle={movie.title}
          playback={{
            profileId: activeProfile?.id,
            media,
            initialPosition: intent === "resume" ? saved.progress?.position || 0 : 0,
            resetProgress: intent === "start",
          }}
        />
      ) : null}
    </div>
  );
}
