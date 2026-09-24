"use client";

import Image from "next/image";
import { useEffect, useEffectEvent, useMemo, useReducer, useRef, useState } from "react";
import SourcePanel from "./SourcePanel.js";
import ReadyEpisodes from "./ReadyEpisodes.js";
import { useSourceLookup } from "./useSourceLookup.js";
import useSavedProgress from "./useSavedProgress.js";
import { useProfile } from "./ProfileProvider.js";
import { formatPlaybackTime } from "../lib/history/presentation.js";
import { findEpisodeFile } from "../lib/video/episode.js";
import { autoplayReducer } from "../lib/playback/autoplay.js";

async function readJson(response) {
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Could not load that season.");
  return data;
}

function episodeCode(season, episode) {
  return `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
}

export default function ShowDetails({ show, initialSeason, initialEpisodeNumber = null, initialIntent = null }) {
  const { activeProfile } = useProfile();
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
  const [readyEpisodes, setReadyEpisodes] = useState([]);
  const [readyLoading, setReadyLoading] = useState(true);
  const [readyUnavailable, setReadyUnavailable] = useState(false);
  const lookup = useSourceLookup();
  const playbackRef = useRef(null);
  const autoplayAbortRef = useRef(null);
  const preparingNextRef = useRef(false);
  const advancingRef = useRef(false);
  const lastReadySessionRef = useRef(null);
  const [autoplay, dispatchAutoplay] = useReducer(autoplayReducer, {
    phase: "idle",
    endReached: false,
  });
  const selectedEpisodeKey = selectedEpisode ? `${selectedEpisode.season}:${selectedEpisode.number}` : null;
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
  const playerFile = lookup.session?.status === "ready" && selectedEpisode
    ? lookup.session.files.find((file) => file.id === lookup.selectedFileId)
      || lookup.session.files.find((file) => file.id === lookup.session.suggestedFileId)
      || findEpisodeFile(lookup.session.files, selectedEpisode.season, selectedEpisode.number)
    : null;
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
  }, []);

  useEffect(() => {
    if (autoplay.phase === "ready" && autoplay.endReached) advanceAfterEnd();
  }, [autoplay.endReached, autoplay.phase]);

  async function clearAutoplay(nextPhase = "reset") {
    autoplayAbortRef.current?.abort();
    autoplayAbortRef.current = null;
    preparingNextRef.current = false;
    advancingRef.current = false;
    dispatchAutoplay({ type: nextPhase });
  }

  async function changeSeason(event) {
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
    const selected = { ...item, season: season.number };
    await clearAutoplay();
    await lookup.stop();
    setPlayingSeason(season);
    setSelectedEpisode(selected);
    setPlaybackIntent(null);
    setLaunchedEpisodeKey(null);
    setAutoStartEpisodeKey(null);
  }

  async function launchEpisode(intent, episode = selectedEpisode) {
    if (!episode) return;
    await clearAutoplay();
    setPlaybackIntent(intent);
    setLaunchedEpisodeKey(`${episode.season}:${episode.number}`);
    setAutoStartEpisodeKey(null);
    await lookup.search({
      type: "show",
      query: show.title,
      tmdbId: show.id,
      imdbId: show.imdbId,
      year: show.year,
      season: episode.season,
      episode: episode.number,
    });
  }

  async function playReadyEpisode(number) {
    const item = season.episodes.find((entry) => entry.number === number)
      || { number, title: `Episode ${number}` };
    const selected = { ...item, season: season.number };
    await chooseEpisode(item);
    await launchEpisode("start", selected);
  }

  async function getSeason(number) {
    if (season.number === number) return season;
    const response = await fetch(`/api/metadata/shows/${show.id}/seasons/${number}`, { cache: "no-store" });
    return readJson(response);
  }

  async function prepareNextEpisode(endReached = false) {
    if (!lookup.session?.id || autoplay.phase !== "idle" || preparingNextRef.current) {
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
    if (autoplay.phase !== "ready" || advancingRef.current) return;
    advancingRef.current = true;
    dispatchAutoplay({ type: "advancing" });
    const prepared = autoplay;
    try {
      const { nextSeason, selected } = await resolveEpisodeDetails(prepared.nextEpisode);
      const response = await fetch("/api/playback/next-episode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "advance",
          sessionId: lookup.session.id,
          season: prepared.nextEpisode.season,
          episode: prepared.nextEpisode.number,
        }),
      });
      await readJson(response);

      setSeason(nextSeason);
      setPlayingSeason(nextSeason);
      setSelectedSeasonNumber(nextSeason.number);
      setSelectedEpisode(selected);
      setPlaybackIntent("start");
      setLaunchedEpisodeKey(`${prepared.nextEpisode.season}:${prepared.nextEpisode.number}`);
      setAutoStartEpisodeKey(`${prepared.nextEpisode.season}:${prepared.nextEpisode.number}`);
      lookup.setSelectedFileId(prepared.fileId);
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

  async function chooseNextSource() {
    if (!autoplay.nextEpisode) return;
    const nextEpisode = autoplay.nextEpisode;
    await clearAutoplay();
    try {
      const { nextSeason, selected } = await resolveEpisodeDetails(nextEpisode);
      setSeason(nextSeason);
      setPlayingSeason(nextSeason);
      setSelectedSeasonNumber(nextSeason.number);
      setSelectedEpisode(selected);
      setPlaybackIntent("start");
      setLaunchedEpisodeKey(`${nextEpisode.season}:${nextEpisode.number}`);
      setAutoStartEpisodeKey(null);
      await lookup.search({
        type: "show",
        query: show.title,
        tmdbId: show.id,
        imdbId: show.imdbId,
        year: show.year,
        season: nextEpisode.season,
        episode: nextEpisode.number,
      });
    } catch (error) {
      dispatchAutoplay({ type: "manual", payload: { error: error.message, nextEpisode } });
    }
  }

  /*
   * The next episode is prepared while the current player remains mounted. All
   * episode, session, and file state above is committed together only after the
   * preparation succeeds, keeping watch-history ownership on the old player.
   */

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
              onSourceReset={() => clearAutoplay()}
              playback={{
                profileId: activeProfile?.id,
                media,
                initialPosition: playbackIntent === "resume" ? saved.progress?.position || 0 : 0,
                resetProgress: playbackIntent === "start",
                autoStart: autoStartEpisodeKey === selectedEpisodeKey,
                onNearEnd: handleNearEnd,
                onEnded: handleEpisodeEnded,
              }}
            />
          ) : (
            <div className="episodeLaunch panel">
              <span className="eyebrow">{episodeCode(selectedEpisode.season, selectedEpisode.number)}</span>
              <h2>{selectedEpisode.title}</h2>
              <div className="resumeActions">
                {resumable ? <button className="primaryButton" type="button" onClick={() => void launchEpisode("resume")}>Resume at {formatPlaybackTime(saved.progress.position)}</button> : null}
                <button className={resumable ? "secondaryButton" : "primaryButton"} type="button" onClick={() => void launchEpisode("start")}>
                  {saved.progress ? "Start from beginning" : "Find authorized sources"}
                </button>
              </div>
            </div>
          )}
          {launchedEpisodeKey === selectedEpisodeKey && playerFile ? (
            <ReadyEpisodes
              seasonNumber={selectedSeasonNumber}
              seasonName={show.seasons.find((item) => item.number === selectedSeasonNumber)?.name}
              seasonEpisodes={season.number === selectedSeasonNumber ? season.episodes : []}
              episodes={readyEpisodes}
              playing={lookup.session?.backend === "debrid"
                ? { season: selectedEpisode.season, episode: selectedEpisode.number } : null}
              loading={readyLoading}
              unavailable={readyUnavailable}
              disabled={loadingSeason}
              onPlay={(number) => void playReadyEpisode(number)}
            />
          ) : null}
        </div>
      ) : null}

      {autoplay.phase === "resolving" ? <div className="nextEpisodePrompt notice">Finding the next episode…</div> : null}
      {autoplay.phase === "ready" ? (
        <div className="nextEpisodePrompt panel" role="dialog" aria-label="Next episode">
          <strong>Next episode is ready</strong>
          <span>{episodeCode(autoplay.nextEpisode.season, autoplay.nextEpisode.number)} · {autoplay.nextEpisode.title}</span>
          <div><button className="primaryButton compact" type="button" onClick={() => void playNextEpisode()}>Play Now</button><button className="secondaryButton" type="button" onClick={() => void cancelAutoplay()}>Cancel</button></div>
        </div>
      ) : null}
      {autoplay.phase === "manual" ? (
        <div className="nextEpisodePrompt notice error">
          <p>Choose a source{autoplay.nextEpisode ? ` for ${episodeCode(autoplay.nextEpisode.season, autoplay.nextEpisode.number)}` : ""}. {autoplay.error || ""}</p>
          <div>{autoplay.nextEpisode ? <button className="primaryButton compact" type="button" onClick={() => void chooseNextSource()}>Choose Source</button> : null}<button className="secondaryButton" type="button" onClick={() => void cancelAutoplay()}>Back to Show</button></div>
        </div>
      ) : null}

      <section className="seasonSection" aria-labelledby="episodes-heading">
        <div className="seasonToolbar">
          <div>
            <span className="eyebrow">Episodes</span>
            <h2 id="episodes-heading">{season?.name || "Seasons"}</h2>
          </div>
          <label>
            <span className="srOnly">Choose a season</span>
            <select value={selectedSeasonNumber} onChange={changeSeason} disabled={loadingSeason}>
              {show.seasons.map((item) => (
                <option value={item.number} key={item.number}>{item.name}</option>
              ))}
            </select>
          </label>
        </div>

        {seasonError ? <div className="notice error" role="alert">{seasonError}</div> : null}
        {loadingSeason ? <div className="notice">Loading episodes…</div> : null}
        {!loadingSeason && season?.episodes.length === 0 ? (
          <div className="notice">No episode data is available for this season.</div>
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
