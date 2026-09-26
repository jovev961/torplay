"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect, useEffectEvent, useMemo, useReducer, useRef, useState } from "react";
import SourcePanel from "./SourcePanel.js";
import ReadyEpisodes, { shouldShowReadyEpisodes } from "./ReadyEpisodes.js";
import { useSourceLookup } from "./useSourceLookup.js";
import useSavedProgress from "./useSavedProgress.js";
import { useProfile } from "./ProfileProvider.js";
import { formatPlaybackTime } from "../lib/history/presentation.js";
import { findEpisodeFile } from "../lib/video/episode.js";
import { autoplayReducer } from "../lib/playback/autoplay.js";
import { useI18n } from "./I18nProvider.js";
import { useWatchTogether } from "./WatchTogetherProvider.js";
import { mediaIdentityHref, sameMediaIdentity } from "../lib/watch-together/protocol.js";

async function readJson(response) {
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Could not load that season.");
  return data;
}

function episodeCode(season, episode) {
  return `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
}

export default function ShowDetails({ show, initialSeason, initialEpisodeNumber = null, initialIntent = null }) {
  const { t } = useI18n();
  const { activeProfile } = useProfile();
  const router = useRouter();
  const watchTogether = useWatchTogether();
  const registerPageMedia = watchTogether.registerPageMedia;
  const [season, setSeason] = useState(initialSeason);
  const [playingSeason, setPlayingSeason] = useState(initialSeason);
  const [selectedSeasonNumber, setSelectedSeasonNumber] = useState(initialSeason.number);
  const [loadingSeason, setLoadingSeason] = useState(false);
  const [seasonError, setSeasonError] = useState("");
  const [selectedEpisode, setSelectedEpisode] = useState(() => {
    const episode = initialSeason.episodes.find((item) => item.number === initialEpisodeNumber);
    return episode ? { ...episode, season: initialSeason.number } : null;
  });
  const [playbackIntent, setPlaybackIntent] = useState(initialIntent);
  const [launchedEpisodeKey, setLaunchedEpisodeKey] = useState(null);
  const [autoStartEpisodeKey, setAutoStartEpisodeKey] = useState(null);
  const [transitionPosition, setTransitionPosition] = useState(null);
  const [episodeNavigationError, setEpisodeNavigationError] = useState("");
  const [previousBusy, setPreviousBusy] = useState(false);
  const [pendingEpisode, setPendingEpisode] = useState(null);
  const [readyEpisodes, setReadyEpisodes] = useState([]);
  const [readyLoading, setReadyLoading] = useState(true);
  const [readyUnavailable, setReadyUnavailable] = useState(false);
  const lookup = useSourceLookup();
  const playbackRef = useRef(null);
  const autoplayAbortRef = useRef(null);
  const prefetchRef = useRef(null);
  const preparingNextRef = useRef(false);
  const advancingRef = useRef(false);
  const lastReadySessionRef = useRef(null);
  const pendingSourceClearedRef = useRef(false);
  const manualNextRequestedRef = useRef(false);
  const restoredEpisodeRef = useRef("");
  const [playbackPreferences, setPlaybackPreferences] = useState({
    autoSkipIntrosRecaps: false, autoPlayNextEpisode: false,
  });
  const [autoplay, dispatchAutoplay] = useReducer(autoplayReducer, {
    phase: "idle",
    endReached: false,
  });
  const selectedEpisodeKey = selectedEpisode ? `${selectedEpisode.season}:${selectedEpisode.number}` : null;
  const currentEpisodeIndex = selectedEpisode?.season === playingSeason.number
    ? playingSeason.episodes.findIndex((item) => item.number === selectedEpisode.number) : -1;
  const hasPreviousEpisode = currentEpisodeIndex > 0
    || show.seasons.some((item) => item.number > 0 && item.number < selectedEpisode?.season);
  const hasNextEpisode = currentEpisodeIndex >= 0 && currentEpisodeIndex < playingSeason.episodes.length - 1
    || show.seasons.some((item) => item.number > selectedEpisode?.season);
  const media = useMemo(() => selectedEpisode ? ({
    mediaType: "tv",
    tmdbId: show.id,
    seasonNumber: selectedEpisode.season,
    episodeNumber: selectedEpisode.number,
    title: show.title,
    episodeTitle: selectedEpisode.title,
    posterUrl: show.posterUrl,
    backdropUrl: selectedEpisode.stillUrl || show.backdropUrl,
  }) : null, [selectedEpisode, show]);
  const saved = useSavedProgress(activeProfile?.id, media);
  const resumable = saved.progress && !saved.progress.completed && saved.progress.position >= 30;
  const readySessionId = lookup.session?.backend === "debrid" ? lookup.session.id : null;
  const guestMediaLocked = Boolean(watchTogether.isGuest && watchTogether.room);
  const roomMediaMismatch = Boolean(guestMediaLocked
    && !sameMediaIdentity(watchTogether.room.media, media));
  const roomMediaHref = roomMediaMismatch ? mediaIdentityHref(watchTogether.room.media) : null;
  const restoreCachedEpisode = useEffectEvent(async (episode, key) => {
    const hit = await lookup.restore({
      type: "show",
      query: show.sourceTitle || show.title,
      originalTitle: show.originalTitle,
      tmdbId: show.id,
      imdbId: show.imdbId,
      year: show.year,
      season: episode.season,
      episode: episode.number,
    });
    if (!hit || selectedEpisodeKey !== key) return;
    const initialKey = initialEpisodeNumber
      ? `${initialSeason.number}:${initialEpisodeNumber}` : null;
    setPlaybackIntent(key === initialKey && initialIntent
      ? initialIntent : resumable ? "resume" : "start");
    setPlayingSeason(season);
    setLaunchedEpisodeKey(key);
    setTransitionPosition(null);
  });

  useEffect(() => registerPageMedia(roomMediaMismatch ? null : media),
    [media, registerPageMedia, roomMediaMismatch]);

  useEffect(() => {
    if (roomMediaHref) router.replace(roomMediaHref);
  }, [roomMediaHref, router]);

  useEffect(() => {
    if (!selectedEpisode || saved.loading || guestMediaLocked || launchedEpisodeKey === selectedEpisodeKey) return;
    const key = `${activeProfile?.id || "guest"}:show:${show.id}:${selectedEpisodeKey}`;
    if (restoredEpisodeRef.current === key) return;
    restoredEpisodeRef.current = key;
    void restoreCachedEpisode(selectedEpisode, selectedEpisodeKey);
  }, [activeProfile?.id, guestMediaLocked, launchedEpisodeKey, saved.loading,
    selectedEpisode, selectedEpisodeKey, show.id]);

  useEffect(() => {
    if (media && watchTogether.room && watchTogether.isHost && !watchTogether.matchesMedia(media)) {
      watchTogether.changeMedia(media);
    }
  }, [media, watchTogether]);
  const playerFile = lookup.session?.status === "ready" && selectedEpisode
    ? lookup.session.files.find((file) => file.id === lookup.selectedFileId)
      || lookup.session.files.find((file) => file.id === lookup.session.suggestedFileId)
      || findEpisodeFile(lookup.session.files, selectedEpisode.season, selectedEpisode.number)
    : null;
  useEffect(() => {
    if (!pendingEpisode) return undefined;
    if (!lookup.session) {
      pendingSourceClearedRef.current = true;
      return undefined;
    }
    if (lookup.session.status !== "ready" || !pendingSourceClearedRef.current) return undefined;
    const file = lookup.session.files.find((entry) => entry.id === lookup.selectedFileId)
      || lookup.session.files.find((entry) => entry.id === lookup.session.suggestedFileId)
      || findEpisodeFile(lookup.session.files, pendingEpisode.selected.season, pendingEpisode.selected.number);
    if (!file) return undefined;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setSeason(pendingEpisode.nextSeason);
      setPlayingSeason(pendingEpisode.nextSeason);
      setSelectedSeasonNumber(pendingEpisode.nextSeason.number);
      setSelectedEpisode(pendingEpisode.selected);
      setPlaybackIntent(pendingEpisode.resumePosition > 0 ? "resume" : "start");
      setTransitionPosition(pendingEpisode.resumePosition);
      const key = `${pendingEpisode.selected.season}:${pendingEpisode.selected.number}`;
      setLaunchedEpisodeKey(key);
      setAutoStartEpisodeKey(key);
      lookup.setSelectedFileId(file.id);
      setPendingEpisode(null);
      setEpisodeNavigationError("");
    });
    return () => { cancelled = true; };
  }, [lookup, lookup.selectedFileId, lookup.session, pendingEpisode]);
  const advanceAfterEnd = useEffectEvent(() => {
    void playNextEpisode();
  });

  useEffect(() => {
    if (selectedEpisode) {
      playbackRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [selectedEpisode]);

  useEffect(() => {
    if (!readySessionId && lastReadySessionRef.current) return undefined;
    if (readySessionId) lastReadySessionRef.current = readySessionId;
    const controller = new AbortController();
    void fetch(`/api/playback/debrid/episodes?tmdbId=${encodeURIComponent(show.id)}`,
      { cache: "no-store", signal: controller.signal })
      .then(readJson)
      .then((data) => {
        setReadyEpisodes(data.episodes || []);
        setReadyUnavailable(data.temporarilyUnavailable === true);
      })
      .catch((error) => { if (error.name !== "AbortError") setReadyUnavailable(true); })
      .finally(() => { if (!controller.signal.aborted) setReadyLoading(false); });
    return () => controller.abort();
  }, [show.id, readySessionId]);

  useEffect(() => {
    if (lookup.session?.id) {
      playbackRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [lookup.session?.id]);

  useEffect(() => () => {
    autoplayAbortRef.current?.abort();
    const pending = prefetchRef.current;
    pending?.controller.abort();
    if (pending) {
      void fetch(`/api/torrents/${encodeURIComponent(pending.sessionId)}/files/${encodeURIComponent(pending.fileId)}/prefetch`, {
        method: "DELETE", keepalive: true,
      }).catch(() => {});
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/settings", { cache: "no-store" })
      .then(readJson)
      .then((snapshot) => {
        if (!cancelled) setPlaybackPreferences({
          autoSkipIntrosRecaps: snapshot.playback.autoSkipIntrosRecaps === true,
          autoPlayNextEpisode: snapshot.playback.autoPlayNextEpisode === true,
        });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!guestMediaLocked && autoplay.phase === "ready" && (manualNextRequestedRef.current
      || (autoplay.endReached && playbackPreferences.autoPlayNextEpisode))) advanceAfterEnd();
  }, [autoplay.endReached, autoplay.phase, guestMediaLocked, playbackPreferences.autoPlayNextEpisode]);

  function stopNextEpisodePrefetch() {
    const pending = prefetchRef.current;
    prefetchRef.current = null;
    if (!pending) return;
    pending.controller.abort();
    void fetch(`/api/torrents/${encodeURIComponent(pending.sessionId)}/files/${encodeURIComponent(pending.fileId)}/prefetch`, {
      method: "DELETE", keepalive: true,
    }).catch(() => {});
  }

  function startNextEpisodePrefetch(fileId) {
    if (!lookup.session?.id || lookup.session.backend === "debrid") return;
    const pending = prefetchRef.current;
    if (pending?.sessionId === lookup.session.id && pending.fileId === String(fileId)) return;
    if (pending) stopNextEpisodePrefetch();
    const controller = new AbortController();
    prefetchRef.current = { sessionId: lookup.session.id, fileId: String(fileId), controller };
    void fetch(`/api/torrents/${encodeURIComponent(lookup.session.id)}/files/${encodeURIComponent(fileId)}/prefetch`, {
      method: "POST", signal: controller.signal,
    }).catch(() => {});
  }

  async function clearAutoplay(nextPhase = "reset") {
    autoplayAbortRef.current?.abort();
    autoplayAbortRef.current = null;
    stopNextEpisodePrefetch();
    preparingNextRef.current = false;
    advancingRef.current = false;
    manualNextRequestedRef.current = false;
    dispatchAutoplay({ type: nextPhase });
    setEpisodeNavigationError("");
  }

  async function changeSeason(event) {
    if (guestMediaLocked) return;
    const number = Number(event.target.value);
    setSelectedSeasonNumber(number);
    setLoadingSeason(true);
    setSeasonError("");
    if (!lookup.session?.id) {
      setSelectedEpisode(null);
      setLaunchedEpisodeKey(null);
      setAutoStartEpisodeKey(null);
      await clearAutoplay();
    }
    try {
      const response = await fetch(`/api/metadata/shows/${show.id}/seasons/${number}`, {
        cache: "no-store",
      });
      setSeason(await readJson(response));
    } catch (error) {
      setSeasonError(error.message);
      setSelectedSeasonNumber(season.number);
    } finally {
      setLoadingSeason(false);
    }
  }

  async function chooseEpisode(item) {
    if (guestMediaLocked) return;
    const selected = { ...item, season: season.number };
    if (pendingEpisode) {
      await clearAutoplay();
      await beginSourceSelection(selected);
      return;
    }
    if (lookup.session?.id && launchedEpisodeKey === selectedEpisodeKey && playerFile) {
      if (selected.season === selectedEpisode.season && selected.number === selectedEpisode.number) return;
      await clearAutoplay();
      setEpisodeNavigationError("");
      try {
        const result = await readJson(await fetch("/api/playback/next-episode", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: lookup.session.id, direction: "selected",
            target: { season: selected.season, episode: selected.number } }),
        }));
        if (result.status === "ready") {
          await commitReusableEpisode(selected, result.fileId);
        } else if (result.status === "manual-required") {
          await beginSourceSelection(selected);
        }
      } catch (error) {
        setEpisodeNavigationError(error.message);
      }
      return;
    }
    await clearAutoplay();
    await lookup.stop();
    setPlayingSeason(season);
    setSelectedEpisode(selected);
    setPlaybackIntent(null);
    setLaunchedEpisodeKey(null);
    setAutoStartEpisodeKey(null);
    setTransitionPosition(null);
  }

  async function launchEpisode(intent, episode = selectedEpisode) {
    if (!episode) return;
    await clearAutoplay();
    setPlaybackIntent(intent);
    setLaunchedEpisodeKey(`${episode.season}:${episode.number}`);
    setAutoStartEpisodeKey(null);
    setTransitionPosition(null);
    await lookup.search({
      type: "show",
      query: show.sourceTitle || show.title,
      originalTitle: show.originalTitle,
      tmdbId: show.id,
      imdbId: show.imdbId,
      year: show.year,
      season: episode.season,
      episode: episode.number,
    });
  }

  async function playReadyEpisode(number) {
    if (guestMediaLocked) return;
    const item = season.episodes.find((entry) => entry.number === number)
      || { number, title: `Episode ${number}` };
    const selected = { ...item, season: season.number };
    if (pendingEpisode || (lookup.session?.id && launchedEpisodeKey === selectedEpisodeKey && playerFile)) {
      await chooseEpisode(item);
      return;
    }
    await chooseEpisode(item);
    await launchEpisode("start", selected);
  }

  async function getSeason(number) {
    if (season.number === number) return season;
    const response = await fetch(`/api/metadata/shows/${show.id}/seasons/${number}`, { cache: "no-store" });
    return readJson(response);
  }

  async function prepareNextEpisode(endReached = false, fromManual = false) {
    if (guestMediaLocked) return;
    if (fromManual) manualNextRequestedRef.current = true;
    if (!lookup.session?.id || !["idle", ...(fromManual ? ["cancelled"] : [])].includes(autoplay.phase)
      || preparingNextRef.current) {
      if (endReached) dispatchAutoplay({ type: "ended" });
      return;
    }
    preparingNextRef.current = true;
    dispatchAutoplay({ type: "resolving", endReached });
    const controller = new AbortController();
    autoplayAbortRef.current = controller;
    let resolvedEpisode = null;
    try {
      const response = await fetch("/api/playback/next-episode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: lookup.session.id }),
        signal: controller.signal,
      });
      const result = await readJson(response);
      resolvedEpisode = result.nextEpisode || null;
      if (result.status === "end-of-series") {
        dispatchAutoplay({ type: "end" });
        return;
      }
      if (result.status === "manual-required") {
        dispatchAutoplay({ type: "manual", payload: result });
        return;
      }
      startNextEpisodePrefetch(result.fileId);
      dispatchAutoplay({ type: "ready", payload: result });
    } catch (error) {
      if (error.name !== "AbortError") {
        dispatchAutoplay({ type: "manual", payload: { error: error.message, nextEpisode: resolvedEpisode } });
      }
    } finally {
      preparingNextRef.current = false;
      if (autoplayAbortRef.current === controller) autoplayAbortRef.current = null;
    }
  }

  async function resolveEpisodeDetails(nextEpisode) {
    const nextSeason = await getSeason(nextEpisode.season);
    const details = nextSeason.episodes.find((episode) => episode.number === nextEpisode.number) || nextEpisode;
    const selected = { ...details, season: nextEpisode.season };
    return { nextSeason, selected };
  }

  async function commitReusableEpisode(episode, fileId, resumePosition = 0) {
    const { nextSeason, selected } = await resolveEpisodeDetails(episode);
    await readJson(await fetch("/api/playback/next-episode", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "advance", sessionId: lookup.session.id,
        season: selected.season, episode: selected.number }),
    }));
    setSeason(nextSeason);
    setPlayingSeason(nextSeason);
    setSelectedSeasonNumber(nextSeason.number);
    setSelectedEpisode(selected);
    setPlaybackIntent(resumePosition > 0 ? "resume" : "start");
    setTransitionPosition(resumePosition);
    const key = `${selected.season}:${selected.number}`;
    setLaunchedEpisodeKey(key);
    setAutoStartEpisodeKey(key);
    lookup.setSelectedFileId(fileId);
  }

  async function beginSourceSelection(episode, resumePosition = 0) {
    const { nextSeason, selected } = await resolveEpisodeDetails(episode);
    pendingSourceClearedRef.current = !lookup.session;
    setPendingEpisode({ nextSeason, selected, resumePosition });
    await lookup.search({ type: "show", query: show.sourceTitle || show.title, originalTitle: show.originalTitle,
      tmdbId: show.id, imdbId: show.imdbId,
      year: show.year, season: selected.season, episode: selected.number });
  }

  function handleNearEnd() {
    void prepareNextEpisode(false);
  }

  function handleEpisodeEnded() {
    if (["cancelled", "end", "advancing"].includes(autoplay.phase)) return;
    if (autoplay.phase === "idle") {
      void prepareNextEpisode(true);
      return;
    }
    dispatchAutoplay({ type: "ended" });
  }

  async function playNextEpisode() {
    if (guestMediaLocked || autoplay.phase !== "ready" || advancingRef.current) return;
    advancingRef.current = true;
    manualNextRequestedRef.current = false;
    dispatchAutoplay({ type: "advancing" });
    const prepared = autoplay;
    try {
      await commitReusableEpisode(prepared.nextEpisode, prepared.fileId);
      advancingRef.current = false;
      dispatchAutoplay({ type: "reset" });
    } catch (error) {
      advancingRef.current = false;
      dispatchAutoplay({
        type: "manual",
        payload: { error: error.message, nextEpisode: prepared.nextEpisode },
      });
    }
  }

  async function cancelAutoplay() {
    await clearAutoplay("cancel");
  }

  async function savePlaybackPreferences(next) {
    const result = await readJson(await fetch("/api/settings/playback", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next),
    }));
    setPlaybackPreferences(result.preferences);
  }

  async function playPreviousEpisode() {
    if (guestMediaLocked || !lookup.session?.id || previousBusy || !hasPreviousEpisode) return;
    setPreviousBusy(true);
    setEpisodeNavigationError("");
    await clearAutoplay();
    try {
      const result = await readJson(await fetch("/api/playback/next-episode", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: lookup.session.id, direction: "previous" }),
      }));
      if (result.status === "end-of-series") return;
      const { selected } = await resolveEpisodeDetails(result.nextEpisode);
      let resumePosition = 0;
      if (activeProfile?.id) {
        const params = new URLSearchParams({ mediaType: "tv", tmdbId: String(show.id),
          seasonNumber: String(selected.season), episodeNumber: String(selected.number) });
        const progress = await readJson(await fetch(
          `/api/profiles/${encodeURIComponent(activeProfile.id)}/progress?${params}`, { cache: "no-store" }));
        if (progress.progress && !progress.progress.completed) resumePosition = progress.progress.position || 0;
      }
      if (result.status === "manual-required") {
        setEpisodeNavigationError("The current source does not have the previous episode. Choose a source below.");
        await beginSourceSelection(selected, resumePosition);
        return;
      }
      await commitReusableEpisode(selected, result.fileId, resumePosition);
    } catch (error) {
      setEpisodeNavigationError(error.message);
    } finally {
      setPreviousBusy(false);
    }
  }

  function playNextFromControls() {
    if (guestMediaLocked) return;
    if (autoplay.phase === "ready") void playNextEpisode();
    else if (autoplay.phase === "manual") void chooseNextSource();
    else if (autoplay.phase === "resolving") manualNextRequestedRef.current = true;
    else if (!["advancing", "end"].includes(autoplay.phase)) void prepareNextEpisode(false, true);
  }

  async function chooseNextSource() {
    if (guestMediaLocked || !autoplay.nextEpisode) return;
    const nextEpisode = autoplay.nextEpisode;
    await clearAutoplay();
    try {
      await beginSourceSelection(nextEpisode);
    } catch (error) {
      setEpisodeNavigationError(error.message);
    }
  }

  /*
   * The next episode is prepared while the current player remains mounted. All
   * episode, session, and file state above is committed together only after the
   * preparation succeeds, keeping watch-history ownership on the old player.
   */

  if (roomMediaMismatch) {
    return <div className="notice">{t("Following the host’s selection…")}</div>;
  }

  return (
    <>
      {selectedEpisode ? (
        <div className="playbackSection" ref={playbackRef}>
          {launchedEpisodeKey === selectedEpisodeKey ? (
            <SourcePanel
              lookup={lookup}
              heading={`${episodeCode(selectedEpisode.season, selectedEpisode.number)} · ${selectedEpisode.title}`}
              playerTitle={`${show.title} · ${episodeCode(selectedEpisode.season, selectedEpisode.number)} · ${selectedEpisode.title}`}
              episode={{ season: selectedEpisode.season, number: selectedEpisode.number }}
              episodeChoices={playingSeason.episodes.map((item) => ({
                season: playingSeason.number,
                number: item.number,
                title: item.title,
              }))}
              onSourceReset={() => {
                setPendingEpisode(null);
                return clearAutoplay();
              }}
              transitionPending={Boolean(pendingEpisode)}
              pendingEpisodeTitle={pendingEpisode
                ? `${episodeCode(pendingEpisode.selected.season, pendingEpisode.selected.number)} · ${pendingEpisode.selected.title}`
                : null}
              playback={{
                profileId: activeProfile?.id,
                media,
                initialPosition: transitionPosition ?? (playbackIntent === "resume" ? saved.progress?.position || 0 : 0),
                resetProgress: playbackIntent === "start",
                autoStart: !watchTogether.room && autoStartEpisodeKey === selectedEpisodeKey,
                onNearEnd: handleNearEnd,
                onEnded: handleEpisodeEnded,
                onPreviousEpisode: playPreviousEpisode,
                onNextEpisode: playNextFromControls,
                hasPreviousEpisode: hasPreviousEpisode && !previousBusy,
                hasNextEpisode,
                playbackPreferences,
                onPlaybackPreferencesChange: savePlaybackPreferences,
                nextEpisodePrompt: autoplay.phase === "ready" ? {
                  kind: "ready",
                  immediate: manualNextRequestedRef.current,
                  title: t("Up Next"),
                  text: `${episodeCode(autoplay.nextEpisode.season, autoplay.nextEpisode.number)} · ${autoplay.nextEpisode.title}`,
                  action: t("Play Next Episode"),
                  onAction: () => void playNextEpisode(),
                  secondaryAction: t("Cancel"),
                  onSecondaryAction: () => void cancelAutoplay(),
                } : autoplay.phase === "manual" ? {
                  kind: "manual",
                  immediate: manualNextRequestedRef.current,
                  title: t(autoplay.nextEpisode ? "Choose a source" : "Next episode unavailable"),
                  text: autoplay.error || t("Choose a source for the next episode."),
                  action: autoplay.nextEpisode ? t("Choose source") : null,
                  onAction: autoplay.nextEpisode ? () => void chooseNextSource() : null,
                  secondaryAction: t("Dismiss"),
                  onSecondaryAction: () => void cancelAutoplay(),
                } : ["resolving", "advancing"].includes(autoplay.phase) ? {
                  kind: "loading",
                  immediate: manualNextRequestedRef.current,
                  title: t("Up Next"),
                  text: t(autoplay.phase === "advancing" ? "Starting the next episode…" : "Finding the next episode…"),
                } : null,
              }}
            />
          ) : (
            <div className="episodeLaunch panel">
              <span className="eyebrow">{episodeCode(selectedEpisode.season, selectedEpisode.number)}</span>
              <h2>{selectedEpisode.title}</h2>
              <div className="resumeActions">
                {resumable ? <button className="primaryButton" type="button" onClick={() => void launchEpisode("resume")}>{t(`Resume at ${formatPlaybackTime(saved.progress.position)}`)}</button> : null}
                <button className={resumable ? "secondaryButton" : "primaryButton"} type="button" onClick={() => void launchEpisode("start")}>
                  {t(saved.progress ? "Start from beginning" : "Find authorized sources")}
                </button>
              </div>
            </div>
          )}
          {shouldShowReadyEpisodes({ session: lookup.session, hasPlayerFile: Boolean(playerFile),
            launchedEpisodeKey, selectedEpisodeKey }) ? (
            <ReadyEpisodes
              seasonNumber={selectedSeasonNumber}
              seasonName={show.seasons.find((item) => item.number === selectedSeasonNumber)?.name}
              seasonEpisodes={season.number === selectedSeasonNumber ? season.episodes : []}
              episodes={readyEpisodes}
              playing={lookup.session?.backend === "debrid"
                ? { season: selectedEpisode.season, episode: selectedEpisode.number } : null}
              loading={readyLoading}
              unavailable={readyUnavailable}
              disabled={loadingSeason || guestMediaLocked}
              onPlay={(number) => void playReadyEpisode(number)}
            />
          ) : null}
        </div>
      ) : null}

      {episodeNavigationError ? <div className="nextEpisodePrompt notice error" role="alert">{episodeNavigationError}</div> : null}

      <section className="seasonSection" aria-labelledby="episodes-heading">
        <div className="seasonToolbar">
          <div>
            <span className="eyebrow">{t("Episodes")}</span>
            <h2 id="episodes-heading">{season?.name || "Seasons"}</h2>
            {guestMediaLocked ? (
              <small className="watchTogetherHint">{t("The host controls the title and episode. Choose your source above.")}</small>
            ) : null}
          </div>
          <label>
            <span className="srOnly">{t("Choose a season")}</span>
            <select value={selectedSeasonNumber} onChange={changeSeason}
              disabled={loadingSeason || guestMediaLocked}>
              {show.seasons.map((item) => (
                <option value={item.number} key={item.number}>{item.name}</option>
              ))}
            </select>
          </label>
        </div>

        {seasonError ? <div className="notice error" role="alert">{seasonError}</div> : null}
        {loadingSeason ? <div className="notice">{t("Loading episodes…")}</div> : null}
        {!loadingSeason && season?.episodes.length === 0 ? (
          <div className="notice">{t("No episode data is available for this season.")}</div>
        ) : null}

        {!loadingSeason && season?.episodes.length > 0 ? (
          <div className="episodeList">
            {season.episodes.map((episode) => {
              const code = episodeCode(season.number, episode.number);
              const active = selectedEpisode?.number === episode.number
                && selectedEpisode?.season === season.number;
              return (
                <button
                  className={active ? "episodeCard active" : "episodeCard"}
                  type="button"
                  key={episode.number}
                  disabled={guestMediaLocked}
                  onClick={() => chooseEpisode(episode)}
                >
                  <div className="episodeStill">
                    {episode.stillUrl ? (
                      <Image src={episode.stillUrl} alt="" fill sizes="(max-width: 700px) 100vw, 240px" />
                    ) : (
                      <div className="imageFallback" aria-hidden="true">{code}</div>
                    )}
                  </div>
                  <div className="episodeCopy">
                    <div className="episodeTitle">
                      <span>{code}</span>
                      <h3>{episode.title}</h3>
                    </div>
                    <p>{episode.overview || "No description is available for this episode."}</p>
                    {episode.airDate ? <small>{episode.airDate}</small> : null}
                  </div>
                </button>
              );
            })}
          </div>
        ) : null}
      </section>
    </>
  );
}
