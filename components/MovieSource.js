"use client";

import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import SourcePanel from "./SourcePanel.js";
import { useSourceLookup } from "./useSourceLookup.js";
import useSavedProgress from "./useSavedProgress.js";
import { useProfile } from "./ProfileProvider.js";
import { formatPlaybackTime } from "../lib/history/presentation.js";
import { useI18n } from "./I18nProvider.js";
import { useWatchTogether } from "./WatchTogetherProvider.js";
import { mediaIdentityHref, sameMediaIdentity } from "../lib/watch-together/protocol.js";

export default function MovieSource({ movie, initialIntent = null }) {
  const { t } = useI18n();
  const { activeProfile } = useProfile();
  const router = useRouter();
  const watchTogether = useWatchTogether();
  const registerPageMedia = watchTogether.registerPageMedia;
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
  const searchCriteria = useMemo(() => ({
    type: "movie",
    query: movie.sourceTitle || movie.title,
    originalTitle: movie.originalTitle,
    tmdbId: movie.id,
    imdbId: movie.imdbId,
    year: movie.year,
  }), [movie]);
  const saved = useSavedProgress(activeProfile?.id, media);
  const resumable = saved.progress && !saved.progress.completed && saved.progress.position >= 30;
  const roomMediaMismatch = Boolean(watchTogether.isGuest && watchTogether.room
    && !sameMediaIdentity(watchTogether.room.media, media));
  const roomMediaHref = roomMediaMismatch ? mediaIdentityHref(watchTogether.room.media) : null;
  const restoredMediaRef = useRef("");
  const restoreCachedSources = useEffectEvent(async () => {
    const hit = await lookup.restore(searchCriteria);
    if (hit) setIntent(initialIntent || (resumable ? "resume" : "start"));
  });

  useEffect(() => registerPageMedia(roomMediaMismatch ? null : media),
    [media, registerPageMedia, roomMediaMismatch]);

  useEffect(() => {
    if (roomMediaHref) router.replace(roomMediaHref);
  }, [roomMediaHref, router]);

  useEffect(() => {
    const key = `${activeProfile?.id || "guest"}:movie:${movie.id}`;
    if (saved.loading || roomMediaMismatch || restoredMediaRef.current === key) return;
    restoredMediaRef.current = key;
    void restoreCachedSources();
  }, [activeProfile?.id, movie.id, roomMediaMismatch, saved.loading]);

  useEffect(() => {
    if (lookup.session?.id) {
      workspaceRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [lookup.session?.id]);

  async function findSources(nextIntent) {
    setIntent(nextIntent);
    await lookup.search(searchCriteria);
  }

  if (roomMediaMismatch) {
    return <div className="sourceWorkspace notice">{t("Following the host’s selection…")}</div>;
  }

  return (
    <div className="sourceWorkspace" ref={workspaceRef}>
      {!lookup.hasSearched ? (
        <div className="resumeActions">
          {resumable ? <button className="primaryButton" type="button" onClick={() => void findSources("resume")}>{t(`Resume from ${formatPlaybackTime(saved.progress.position)}`)}</button> : null}
          <button className={resumable ? "secondaryButton" : "primaryButton"} type="button" onClick={() => void findSources("start")}>
            {t(saved.progress ? "Start from beginning" : "Find authorized sources")}
          </button>
          {saved.error ? <span className="muted">{t("Progress unavailable; playback still works.")}</span> : null}
        </div>
      ) : null}
      {lookup.hasSearched ? (
        <SourcePanel
          lookup={lookup}
          heading={t(`Sources for ${movie.title}`)}
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
