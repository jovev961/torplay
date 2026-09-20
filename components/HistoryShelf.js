"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  episodeCode,
  formatPlaybackTime,
  historyHref,
  historyPrimaryAction,
  historyProgress,
} from "../lib/history/presentation.js";
import { useProfile } from "./ProfileProvider.js";

export { formatPlaybackTime, historyHref } from "../lib/history/presentation.js";

function itemKey(item) {
  return `${item.mediaType}:${item.tmdbId}`;
}

function HistoryOverflowMenu({ item, removing, onRemove }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef(null);
  const triggerRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    function closeMenu(event) {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      } else if (event.type === "pointerdown" && !menuRef.current?.contains(event.target)) {
        setOpen(false);
      }
    }
    document.addEventListener("keydown", closeMenu);
    document.addEventListener("pointerdown", closeMenu);
    return () => {
      document.removeEventListener("keydown", closeMenu);
      document.removeEventListener("pointerdown", closeMenu);
    };
  }, [open]);

  return (
    <div className="historyOverflow" ref={menuRef}>
      <button
        className="historyOverflowTrigger"
        type="button"
        ref={triggerRef}
        disabled={removing}
        aria-label={`More actions for ${item.title}`}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span aria-hidden="true">•••</span>
      </button>
      {open ? (
        <div className="historyOverflowMenu">
          {!item.completed ? (
            <Link href={historyHref(item, "start")} onClick={() => setOpen(false)}>
              Play from beginning
            </Link>
          ) : null}
          <button
            type="button"
            disabled={removing}
            onClick={() => {
              setOpen(false);
              onRemove(item);
            }}
          >
            {removing ? "Removing…" : "Remove from history"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function EpisodeHistoryDialog({ item, returnFocus, onClose }) {
  const dialogRef = useRef(null);
  const closeRef = useRef(null);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();

    function handleKeyDown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...(dialogRef.current?.querySelectorAll(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) || [])];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      returnFocus?.focus();
    };
  }, [onClose, returnFocus]);

  return (
    <div
      className="episodeHistoryBackdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="episodeHistoryDialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="episode-history-title"
        ref={dialogRef}
      >
        <div className="episodeHistoryHeading">
          <div>
            <span className="eyebrow">Episode history</span>
            <h2 id="episode-history-title">{item.title}</h2>
            <p>{item.episodes.length} {item.episodes.length === 1 ? "episode" : "episodes"} watched</p>
          </div>
          <button
            className="episodeHistoryClose"
            type="button"
            ref={closeRef}
            aria-label={`Close ${item.title} episode history`}
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <div className="episodeHistoryList">
          {item.episodes.map((episode) => {
            const action = historyPrimaryAction(episode);
            const progress = historyProgress(episode);
            return (
              <article key={`${episode.seasonNumber}:${episode.episodeNumber}`}>
                <div className="episodeHistoryCopy">
                  <strong>{episodeCode(episode)} · {episode.episodeTitle || "Episode"}</strong>
                  <span>
                    {episode.completed
                      ? "Completed"
                      : `${formatPlaybackTime(episode.position)} / ${formatPlaybackTime(episode.duration)}`}
                  </span>
                  <progress value={progress} max="1">{Math.round(progress * 100)}%</progress>
                </div>
                <div className="episodeHistoryActions">
                  <Link href={action.href}>{action.label}</Link>
                  {!episode.completed ? <Link className="episodeRestartAction" href={historyHref(episode, "start")}>Start over</Link> : null}
                </div>
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}

export function HistoryCard({ item, actions = false, removable = false, removing = false, onRemove, onViewEpisodes }) {
  const progress = historyProgress(item);
  const action = historyPrimaryAction(item);
  return (
    <article className={removing ? "historyCard removing" : "historyCard"}>
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
      {actions ? <HistoryOverflowMenu item={item} removing={removing} onRemove={onRemove} /> : null}
      <Link className="historyCardLink" href={actions ? action.href : historyHref(item)}>
        <div className="historyArtwork">
          {item.posterUrl ? <Image src={item.posterUrl} alt="" fill sizes="(max-width: 720px) 44vw, 190px" /> : <div className="imageFallback">{item.title.slice(0, 1)}</div>}
          {item.completed ? <span className="historyCompletedBadge">Completed</span> : null}
          <progress value={progress} max="1">{Math.round(progress * 100)}%</progress>
        </div>
        <div className="cardCopy">
          <h3>{item.title}</h3>
          {item.mediaType === "tv" ? <span>{episodeCode(item)}{item.episodeTitle ? ` · ${item.episodeTitle}` : ""}</span> : null}
          <span>{formatPlaybackTime(item.position)} / {formatPlaybackTime(item.duration)}</span>
        </div>
      </Link>
      {actions ? (
        <div className="historyActions">
          <Link className="historyPrimaryAction" href={action.href}>{action.label}</Link>
          {item.mediaType === "tv" ? (
            <button type="button" onClick={(event) => onViewEpisodes(item, event.currentTarget)}>
              View episodes
            </button>
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
  const [episodeDialog, setEpisodeDialog] = useState(null);
  const closeEpisodeDialog = useCallback(() => setEpisodeDialog(null), []);

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
          onViewEpisodes={(show, trigger) => setEpisodeDialog({ item: show, returnFocus: trigger })}
        />;
      })}</div> : null}
      {episodeDialog ? (
        <EpisodeHistoryDialog
          item={episodeDialog.item}
          returnFocus={episodeDialog.returnFocus}
          onClose={closeEpisodeDialog}
        />
      ) : null}
    </section>
  );
}
