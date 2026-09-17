"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useProfile } from "./ProfileProvider.js";

export function formatPlaybackTime(value) {
  const total = Math.max(0, Math.floor(Number(value) || 0));
  const seconds = String(total % 60).padStart(2, "0");
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

export function historyHref(item, mode = "resume") {
  const params = new URLSearchParams({ [mode]: "1" });
  if (item.mediaType === "tv") {
    params.set("season", String(item.seasonNumber));
    params.set("episode", String(item.episodeNumber));
  }
  return `${item.mediaType === "movie" ? "/movies" : "/shows"}/${item.tmdbId}?${params}`;
}

function itemKey(item) {
  return `${item.mediaType}:${item.tmdbId}`;
}

function episodeCode(item) {
  return `S${String(item.seasonNumber).padStart(2, "0")}E${String(item.episodeNumber).padStart(2, "0")}`;
}

export function HistoryCard({ item, actions = false, removable = false, removing = false, onRemove }) {
  const [expanded, setExpanded] = useState(false);
  const progress = item.duration > 0 ? Math.min(1, item.position / item.duration) : 0;
  const episodeHistory = actions && item.mediaType === "tv" && item.episodes?.length > 1
    ? item.episodes
    : [];
  return (
    <article className={expanded ? "historyCard expanded" : "historyCard"}>
      {removable ? (
        <button
          className="continueRemove"
          type="button"
          disabled={removing}
          aria-label={`Remove ${item.title} from Continue Watching`}
          title="Remove from Continue Watching"
          onClick={() => onRemove(item)}
        >
          <span aria-hidden="true">×</span>
        </button>
      ) : null}
      <Link href={historyHref(item)}>
        <div className="historyArtwork">
          {item.posterUrl ? <Image src={item.posterUrl} alt="" fill sizes="180px" /> : <div className="imageFallback">{item.title.slice(0, 1)}</div>}
          <progress value={progress} max="1">{Math.round(progress * 100)}%</progress>
        </div>
        <div className="cardCopy">
          <h3>{item.title}</h3>
          {item.mediaType === "tv" ? <span>S{String(item.seasonNumber).padStart(2, "0")}E{String(item.episodeNumber).padStart(2, "0")}{item.episodeTitle ? ` · ${item.episodeTitle}` : ""}</span> : null}
          <span>{formatPlaybackTime(item.position)} / {formatPlaybackTime(item.duration)}</span>
          {item.completed ? <small>Completed</small> : null}
        </div>
      </Link>
      {actions ? <div className="historyActions">
        {!item.completed ? <Link href={historyHref(item)}>Resume</Link> : null}
        <Link href={historyHref(item, "start")}>Play from beginning</Link>
        <button type="button" disabled={removing} onClick={() => onRemove(item)}>
          {removing ? "Removing…" : "Remove"}
        </button>
      </div> : null}
      {episodeHistory.length ? (
        <div className="episodeHistory">
          <button
            className="episodeHistoryToggle"
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? "Hide episodes" : `Show ${episodeHistory.length} episodes`}
          </button>
          {expanded ? (
            <div className="episodeHistoryList">
              {episodeHistory.map((episode) => (
                <article key={`${episode.seasonNumber}:${episode.episodeNumber}`}>
                  <div>
                    <strong>{episodeCode(episode)} · {episode.episodeTitle || "Episode"}</strong>
                    <span>{formatPlaybackTime(episode.position)} / {formatPlaybackTime(episode.duration)}</span>
                    {episode.completed ? <small>Completed</small> : null}
                  </div>
                  <div>
                    {!episode.completed ? <Link href={historyHref(episode)}>Resume</Link> : null}
                    <Link href={historyHref(episode, "start")}>Play from beginning</Link>
                  </div>
                </article>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

export default function HistoryShelf({ full = false }) {
  const { activeProfile } = useProfile();
  const [items, setItems] = useState([]);
  const [loadedProfileId, setLoadedProfileId] = useState(null);
  const [error, setError] = useState("");
  const [removeError, setRemoveError] = useState("");
  const [removingKey, setRemovingKey] = useState(null);

  useEffect(() => {
    if (!activeProfile?.id) return;
    let cancelled = false;
    const endpoint = full ? "history" : "continue-watching";
    void fetch(`/api/profiles/${encodeURIComponent(activeProfile.id)}/${endpoint}`, { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "History unavailable.");
        if (!cancelled) {
          setItems(full ? data.history : data.items);
          setError("");
        }
      })
      .catch((loadError) => { if (!cancelled) setError(loadError.message); })
      .finally(() => { if (!cancelled) setLoadedProfileId(activeProfile.id); });
    return () => { cancelled = true; };
  }, [activeProfile?.id, full]);

  async function removeItem(item) {
    const message = item.mediaType === "tv"
      ? `Remove ${item.title} and all saved episode progress?`
      : `Remove ${item.title} and its saved progress?`;
    if (!window.confirm(message)) return;

    const key = itemKey(item);
    setRemovingKey(key);
    setRemoveError("");
    const params = new URLSearchParams({
      scope: "title",
      mediaType: item.mediaType,
      tmdbId: String(item.tmdbId),
    });
    try {
      const response = await fetch(
        `/api/profiles/${encodeURIComponent(activeProfile.id)}/history?${params}`,
        { method: "DELETE" },
      );
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.error || "Saved progress could not be removed.");
      }
      setItems((current) => current.filter((entry) => itemKey(entry) !== key));
    } catch (removeFailure) {
      setRemoveError(removeFailure.message);
    } finally {
      setRemovingKey(null);
    }
  }

  if (!activeProfile) return null;
  const loaded = loadedProfileId === activeProfile.id;
  const visibleItems = loaded ? items : [];
  if (!full && loaded && (error || visibleItems.length === 0)) return null;
  return (
    <section className={full ? "historyView" : "mediaShelf continueShelf"}>
      <div className="shelfHeading"><h2>{full ? `${activeProfile.name}'s Watch History` : "Continue Watching"}</h2><span>{visibleItems.length ? `${visibleItems.length} titles` : ""}</span></div>
      {error && full ? <div className="notice error">{error}</div> : null}
      {removeError ? <div className="notice error" role="alert">{removeError}</div> : null}
      {loaded && full && !error && visibleItems.length === 0 ? <div className="notice">No watch history yet.</div> : null}
      {visibleItems.length ? <div className={full ? "historyGrid" : "posterRow"}>{visibleItems.map((item) => {
        const key = itemKey(item);
        return <HistoryCard
          key={key}
          item={item}
          actions={full}
          removable={!full}
          removing={removingKey === key}
          onRemove={removeItem}
        />;
      })}</div> : null}
    </section>
  );
}
