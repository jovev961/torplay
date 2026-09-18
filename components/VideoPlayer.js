"use client";

import Hls from "hls.js";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  applySubtitleCuePosition,
  normalizeSubtitleAppearance,
  readSubtitleAppearance,
  SUBTITLE_APPEARANCE_DEFAULTS,
  subtitleAppearanceClassName,
  writeSubtitleAppearance,
} from "../lib/subtitles/appearance.js";
import { automaticSubtitleId } from "../lib/subtitles/selection.js";
import { PROGRESS_SAVE_INTERVAL_MS } from "../lib/history/constants.js";
import { isPlaybackAtEnd, shouldOfferNextEpisode } from "../lib/playback/autoplay.js";
import {
  isFullscreenActive,
  supportsFullscreen,
  toggleBrowserFullscreen,
} from "../lib/video/fullscreen.js";

async function responseJson(response) {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) return null;
  return response.json();
}

function mediaErrorMessage(error) {
  if (!error) return "The browser rejected the HLS video.";
  const labels = {
    1: "playback was aborted",
    2: "a network error interrupted playback",
    3: "the video could not be decoded",
    4: "the video format was not supported",
  };
  const detail = error.message ? ` ${error.message}` : "";
  return `Browser media error ${error.code}: ${labels[error.code] || "unknown media failure"}.${detail}`;
}

function formatTime(value) {
  if (!Number.isFinite(value) || value < 0) return "0:00";
  const seconds = Math.floor(value % 60).toString().padStart(2, "0");
  const minutes = Math.floor(value / 60) % 60;
  const hours = Math.floor(value / 3600);
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

function browserStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function Icon({ name }) {
  const paths = {
    play: <path d="M8 5v14l11-7z" />,
    pause: <path d="M7 5h4v14H7zm6 0h4v14h-4z" />,
    volume: <path d="M4 10v4h4l5 4V6L8 10H4zm11.5 2a3.5 3.5 0 0 0-2-3.15v6.3A3.5 3.5 0 0 0 15.5 12zm0-7.1v2.05a6 6 0 0 1 0 10.1v2.05a8 8 0 0 0 0-14.2z" />,
    muted: <path d="M4 10v4h4l5 4V6L8 10H4zm11.4-.8L14.6 10l2 2-2 2 .8.8 2-2 2 2 .8-.8-2-2 2-2-.8-.8-2 2z" />,
    fullscreen: <path d="M5 5h5v2H7v3H5V5zm9 0h5v5h-2V7h-3V5zM5 14h2v3h3v2H5v-5zm12 0h2v5h-5v-2h3v-3z" />,
    compress: <path d="M8 8H5V6h5v5H8V8zm8 0v3h-2V6h5v2h-3zM8 16v-3h2v5H5v-2h3zm8 0h3v2h-5v-5h2v3z" />,
    pip: <path d="M4 6h16v12H4V6zm2 2v8h12V8H6zm7 3h4v4h-4v-4z" />,
    settings: <path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zm9 4.8v-2.6l-2.1-.6a7 7 0 0 0-.7-1.6l1.1-1.9-1.9-1.9-1.9 1.1a7 7 0 0 0-1.6-.7L13.3 3h-2.6l-.6 2.1a7 7 0 0 0-1.6.7L6.6 4.7 4.7 6.6l1.1 1.9a7 7 0 0 0-.7 1.6l-2.1.6v2.6l2.1.6a7 7 0 0 0 .7 1.6l-1.1 1.9 1.9 1.9 1.9-1.1a7 7 0 0 0 1.6.7l.6 2.1h2.6l.6-2.1a7 7 0 0 0 1.6-.7l1.9 1.1 1.9-1.9-1.1-1.9a7 7 0 0 0 .7-1.6l2.1-.6z" />,
  };
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
      {paths[name]}
    </svg>
  );
}

export default function VideoPlayer({
  sessionId,
  file,
  title,
  profileId = null,
  media = null,
  initialPosition = 0,
  resetProgress = false,
  onNearEnd = null,
  onEnded = null,
}) {
  const playerRef = useRef(null);
  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const abortRef = useRef(null);
  const pollRef = useRef(null);
  const hideTimerRef = useRef(null);
  const seekTimerRef = useRef(null);
  const preparedRef = useRef(false);
  const activeSubtitleRef = useRef(null);
  const subtitleSelectionModeRef = useRef("automatic");
  const recoveryRef = useRef({ media: false, network: false });
  const writerRef = useRef({ token: null, sequence: 0 });
  const timelineRef = useRef({ position: 0, duration: 0 });
  const initialSeekAppliedRef = useRef(false);
  const resetSentRef = useRef(false);
  const endedRef = useRef(false);
  const nearEndNotifiedRef = useRef(false);
  const earlyEndRecoveryRef = useRef(false);
  const [playbackError, setPlaybackError] = useState("");
  const [subtitleError, setSubtitleError] = useState("");
  const [playbackHint, setPlaybackHint] = useState("");
  const [playbackState, setPlaybackState] = useState(
    file.playbackMode === "native" ? "native" : "idle",
  );
  const [playbackDetails, setPlaybackDetails] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [bufferedRanges, setBufferedRanges] = useState([]);
  const [seekPreview, setSeekPreview] = useState(null);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [menu, setMenu] = useState(null);
  const [activeSubtitleId, setActiveSubtitleId] = useState(null);
  const [subtitleDelay, setSubtitleDelay] = useState(0);
  const [subtitleAppearance, setSubtitleAppearance] = useState(SUBTITLE_APPEARANCE_DEFAULTS);
  const [subtitleDiscovery, setSubtitleDiscovery] = useState({
    state: "loading",
    preferences: { defaultLanguage: "en", enabledLanguages: ["en", "mk", "sr", "hr", "bs"] },
    providers: {},
    tracks: [],
  });
  const [playbackRate, setPlaybackRate] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fullscreenSupported, setFullscreenSupported] = useState(false);
  const [pipSupported, setPipSupported] = useState(false);
  const [progressError, setProgressError] = useState("");
  const [writerToken, setWriterToken] = useState(null);
  const baseUrl = `/api/torrents/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(file.id)}`;
  const playbackUrl = `${baseUrl}/playback`;
  const subtitles = subtitleDiscovery.tracks;
  const hlsOrigin = playbackDetails?.originSeconds || 0;
  const subtitleOffsetMs = Math.round(subtitleDelay * 1000 - (file.playbackMode === "transcode" ? hlsOrigin * 1000 : 0));
  const subtitleUrl = `${baseUrl}/subtitles`;
  const subtitleStyleClass = subtitleAppearanceClassName(subtitleAppearance);

  const saveProgress = useCallback(async ({
    position = timelineRef.current.position,
    duration: savedDuration = timelineRef.current.duration,
    reset = false,
    keepalive = false,
  } = {}) => {
    const writerToken = writerRef.current.token;
    if (!profileId || !writerToken || !(savedDuration > 0)) return null;
    const sequence = writerRef.current.sequence + 1;
    writerRef.current.sequence = sequence;
    try {
      const response = await fetch(`/api/profiles/${encodeURIComponent(profileId)}/progress`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ writerToken, sequence, position, duration: savedDuration, reset }),
        keepalive,
      });
      if (!response.ok) {
        const payload = await responseJson(response);
        throw new Error(payload?.error || "Progress could not be saved.");
      }
      setProgressError("");
      return responseJson(response);
    } catch (error) {
      if (!keepalive) setProgressError(error.message);
      return null;
    }
  }, [profileId]);

  function stopPolling() {
    if (!pollRef.current) return;
    clearInterval(pollRef.current);
    pollRef.current = null;
  }

  async function refreshStatus() {
    try {
      const response = await fetch(playbackUrl, { cache: "no-store" });
      const payload = await responseJson(response);
      if (payload?.media) setPlaybackDetails(payload);
      if (payload?.state === "failed" || payload?.error) {
        failPlayback(payload.error?.message || payload.error || "FFmpeg playback failed.");
      } else if (payload?.state === "complete") {
        stopPolling();
      }
      return payload;
    } catch {
      return null;
    }
  }

  function startPolling() {
    if (pollRef.current) return;
    pollRef.current = setInterval(() => void refreshStatus(), 3_000);
  }

  function failPlayback(message) {
    stopPolling();
    hlsRef.current?.destroy();
    hlsRef.current = null;
    setPlaybackState("failed");
    setPlaybackError(message || "The video could not be prepared for playback.");
  }

  async function reportPlayerFailure(message) {
    const status = await refreshStatus();
    if (status?.state !== "failed") failPlayback(message);
  }

  function startPreparedVideo(video) {
    setPlaybackState("ready");
    startPolling();
    void video.play().then(
      () => setPlaybackHint(""),
      (error) => {
        if (error.name === "NotAllowedError" || error.name === "AbortError") {
          setPlaybackHint("Playback is ready. Press play to begin.");
        } else {
          void reportPlayerFailure(`The browser could not start playback: ${error.message}`);
        }
      },
    );
  }

  function attachHls(manifestUrl) {
    const video = videoRef.current;
    if (!video) return;

    recoveryRef.current = { media: false, network: false };
    if (Hls.isSupported()) {
      const hls = new Hls({ enableWorker: false });
      hlsRef.current = hls;
      hls.on(Hls.Events.MEDIA_ATTACHED, () => hls.loadSource(manifestUrl));
      hls.on(Hls.Events.MANIFEST_PARSED, () => startPreparedVideo(video));
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !recoveryRef.current.media) {
          recoveryRef.current.media = true;
          hls.recoverMediaError();
          return;
        }
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && !recoveryRef.current.network) {
          recoveryRef.current.network = true;
          hls.startLoad();
          return;
        }
        void reportPlayerFailure(
          `HLS playback failed: ${data.details || data.error?.message || "unknown player error"}.`,
        );
      });
      hls.attachMedia(video);
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.addEventListener("canplay", () => startPreparedVideo(video), { once: true });
      video.src = manifestUrl;
      video.load();
    } else {
      failPlayback("This browser does not support HLS playback.");
    }
  }

  async function preparePlayback(startTime = 0) {
    abortRef.current?.abort();
    hlsRef.current?.destroy();
    hlsRef.current = null;
    setPlaybackError("");
    setPlaybackHint("");
    setPlaybackState("preparing");
    abortRef.current = new AbortController();
    try {
      const response = await fetch(playbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startTime }),
        signal: abortRef.current.signal,
      });
      const payload = await responseJson(response);
      if (!response.ok) {
        throw new Error(payload?.error || `Playback preparation failed with HTTP ${response.status}.`);
      }
      if (!payload?.manifestUrl) throw new Error("The server did not return an HLS playlist.");
      preparedRef.current = true;
      setPlaybackDetails(payload);
      attachHls(payload.manifestUrl);
    } catch (error) {
      if (error.name !== "AbortError") failPlayback(error.message);
    }
  }

  useEffect(() => {
    setPipSupported(Boolean(document.pictureInPictureEnabled && videoRef.current?.requestPictureInPicture));
    const video = videoRef.current;
    const updateFullscreenState = () => {
      setIsFullscreen(isFullscreenActive(document, playerRef.current, video));
    };
    const updateFullscreenSupport = () => {
      setFullscreenSupported(supportsFullscreen(playerRef.current, video));
    };
    const onNativeFullscreenBegin = () => setIsFullscreen(true);
    const onNativeFullscreenEnd = () => setIsFullscreen(false);

    updateFullscreenState();
    updateFullscreenSupport();
    document.addEventListener("fullscreenchange", updateFullscreenState);
    document.addEventListener("webkitfullscreenchange", updateFullscreenState);
    video?.addEventListener("loadedmetadata", updateFullscreenSupport);
    video?.addEventListener("webkitbeginfullscreen", onNativeFullscreenBegin);
    video?.addEventListener("webkitendfullscreen", onNativeFullscreenEnd);
    return () => {
      document.removeEventListener("fullscreenchange", updateFullscreenState);
      document.removeEventListener("webkitfullscreenchange", updateFullscreenState);
      video?.removeEventListener("loadedmetadata", updateFullscreenSupport);
      video?.removeEventListener("webkitbeginfullscreen", onNativeFullscreenBegin);
      video?.removeEventListener("webkitendfullscreen", onNativeFullscreenEnd);
    };
  }, []);

  useEffect(() => {
    if (!profileId || !media) return undefined;
    let cancelled = false;
    writerRef.current = { token: null, sequence: 0 };
    void fetch(`/api/profiles/${encodeURIComponent(profileId)}/playback-sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...media, reset: resetProgress }),
    }).then(async (response) => {
      const payload = await responseJson(response);
      if (!response.ok) throw new Error(payload?.error || "Progress tracking is unavailable.");
      if (!cancelled) {
        writerRef.current = { token: payload.writerToken, sequence: 0 };
        setWriterToken(payload.writerToken);
      }
    }).catch((error) => { if (!cancelled) setProgressError(error.message); });
    return () => { cancelled = true; };
  }, [media, profileId, resetProgress]);

  useEffect(() => {
    if (!resetProgress || resetSentRef.current || !writerToken || !(duration > 0)) return;
    resetSentRef.current = true;
    void saveProgress({ position: 0, duration, reset: true });
  }, [duration, resetProgress, saveProgress, writerToken]);

  useEffect(() => {
    if (!playing) return undefined;
    const timer = setInterval(() => void saveProgress(), PROGRESS_SAVE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [playing, saveProgress]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setSubtitleAppearance(readSubtitleAppearance(browserStorage()));
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer = null;
    async function update(method) {
      try {
        const response = await fetch(subtitleUrl, { method, cache: "no-store" });
        const payload = await responseJson(response);
        if (!response.ok) throw new Error(payload?.error || "Subtitle discovery failed.");
        if (cancelled) return;
        setSubtitleDiscovery(payload);
        if (subtitleSelectionModeRef.current === "automatic") {
          const nextSubtitleId = automaticSubtitleId(
            payload.tracks,
            payload.preferences.defaultLanguage,
          );
          activeSubtitleRef.current = nextSubtitleId;
          setActiveSubtitleId(nextSubtitleId);
        }
        if (payload.state === "loading") timer = setTimeout(() => void update("GET"), 1_000);
      } catch (error) {
        if (!cancelled) setSubtitleError(error.message);
      }
    }
    void update("POST");
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [subtitleUrl]);

  useEffect(() => {
    const tracks = Array.from(videoRef.current?.textTracks || []);
    subtitles.forEach((subtitle, index) => {
      if (tracks[index]) {
        tracks[index].mode = subtitle.id === activeSubtitleId ? "showing" : "disabled";
        applySubtitleCuePosition(tracks[index], subtitleAppearance.bottomOffsetPercent);
      }
    });
  }, [activeSubtitleId, subtitleAppearance.bottomOffsetPercent, subtitleOffsetMs, subtitles]);

  useEffect(() => () => {
    abortRef.current?.abort();
    stopPolling();
    hlsRef.current?.destroy();
    clearTimeout(hideTimerRef.current);
    clearTimeout(seekTimerRef.current);
    if (preparedRef.current) {
      void fetch(playbackUrl, { method: "DELETE", keepalive: true });
    }
    void saveProgress({ keepalive: true });
  }, [playbackUrl, saveProgress]);

  function revealControls(autoHide = playing && !menu) {
    clearTimeout(hideTimerRef.current);
    setControlsVisible(true);
    if (autoHide) {
      hideTimerRef.current = setTimeout(() => setControlsVisible(false), 2_500);
    }
  }

  function updateTimeline(video) {
    const origin = file.playbackMode === "transcode" ? (playbackDetails?.originSeconds || 0) : 0;
    const nextPosition = origin + (video.currentTime || 0);
    setCurrentTime(nextPosition);
    const reportedDuration = Number(playbackDetails?.duration || playbackDetails?.media?.duration);
    const nextDuration = Number.isFinite(reportedDuration) && reportedDuration > 0
      ? reportedDuration
      : Number.isFinite(video.duration) ? video.duration : 0;
    setDuration(nextDuration);
    timelineRef.current = {
      position: nextPosition,
      duration: nextDuration,
    };
    if (!nearEndNotifiedRef.current && shouldOfferNextEpisode(nextPosition, nextDuration)) {
      nearEndNotifiedRef.current = true;
      onNearEnd?.({ position: nextPosition, duration: nextDuration });
    }
    if (nextDuration > 0 && video.buffered.length) {
      const ranges = Array.from({ length: video.buffered.length }, (_, index) => ({
        start: Math.max(0, origin + video.buffered.start(index)),
        end: Math.min(nextDuration, origin + video.buffered.end(index)),
      }));
      setBufferedRanges(ranges);
    } else {
      setBufferedRanges([]);
    }
    return timelineRef.current;
  }

  function handlePlaybackEnded(video) {
    const timeline = updateTimeline(video);
    setPlaying(false);
    if (!isPlaybackAtEnd(timeline.position, timeline.duration)) {
      void saveProgress(timeline).finally(() => {
        if (file.playbackMode === "transcode" && !earlyEndRecoveryRef.current) {
          earlyEndRecoveryRef.current = true;
          setPlaybackHint("Playback ended before the episode was finished. Resuming from the current position…");
          void preparePlayback(timeline.position);
        } else {
          setPlaybackError("Playback ended before the episode was finished. Your current position was saved.");
        }
      });
      return;
    }

    endedRef.current = true;
    void saveProgress({ position: timeline.duration, duration: timeline.duration }).finally(() => {
      onEnded?.();
    });
  }

  async function togglePlayback() {
    const video = videoRef.current;
    if (!video) return;
    if (file.playbackMode === "transcode" && ["idle", "failed"].includes(playbackState)) {
      await preparePlayback(initialSeekAppliedRef.current ? currentTime : initialPosition);
      initialSeekAppliedRef.current = true;
      return;
    }
    if (video.paused) {
      try {
        await video.play();
      } catch (error) {
        setPlaybackError(`The browser could not start playback: ${error.message}`);
      }
    } else {
      video.pause();
    }
  }

  function selectSubtitle(id, manual = true) {
    if (manual) {
      subtitleSelectionModeRef.current = "user";
    }
    activeSubtitleRef.current = id;
    setActiveSubtitleId(id);
    setSubtitleError("");
    setMenu(null);
    revealControls(playing);
  }

  function toggleCaptions() {
    if (activeSubtitleId !== null) selectSubtitle(null);
    else if (subtitles[0]) selectSubtitle(subtitles[0].id);
  }

  function updateSubtitleAppearance(patch) {
    const next = normalizeSubtitleAppearance({ ...subtitleAppearance, ...patch });
    setSubtitleAppearance(next);
    writeSubtitleAppearance(browserStorage(), next);
  }

  function resetSubtitleAppearance() {
    const next = writeSubtitleAppearance(browserStorage(), SUBTITLE_APPEARANCE_DEFAULTS);
    setSubtitleAppearance(next);
  }

  function requestSeek(target, immediate = false) {
    if (!duration) return;
    const next = Math.max(0, Math.min(duration, Number(target)));
    setSeekPreview(next);
    clearTimeout(seekTimerRef.current);
    const commit = async () => {
      setSeekPreview(null);
      setBuffering(true);
      if (file.playbackMode === "native") {
        if (videoRef.current) videoRef.current.currentTime = next;
        return;
      }
      await preparePlayback(next);
    };
    seekTimerRef.current = setTimeout(() => void commit(), immediate ? 0 : 300);
  }

  async function toggleFullscreen() {
    try {
      await toggleBrowserFullscreen(document, playerRef.current, videoRef.current);
    } catch (error) {
      setPlaybackError(`Fullscreen is unavailable: ${error.message}`);
    }
  }

  async function togglePictureInPicture() {
    const video = videoRef.current;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await video?.requestPictureInPicture();
    } catch (error) {
      setPlaybackError(`Picture-in-picture is unavailable: ${error.message}`);
    }
  }

  function handleKeyboard(event) {
    if (event.target.closest("button, input, select")) return;
    const video = videoRef.current;
    if (!video) return;
    const key = event.key.toLowerCase();
    if (key === " " || key === "k") {
      event.preventDefault();
      void togglePlayback();
    } else if (key === "arrowleft" && duration) {
      event.preventDefault();
      requestSeek(currentTime - 10, true);
    } else if (key === "arrowright" && duration) {
      event.preventDefault();
      requestSeek(currentTime + 10, true);
    } else if (key === "arrowup" || key === "arrowdown") {
      event.preventDefault();
      const nextVolume = Math.min(1, Math.max(0, video.volume + (key === "arrowup" ? 0.05 : -0.05)));
      video.volume = nextVolume;
      video.muted = false;
      setVolume(nextVolume);
      setMuted(false);
    } else if (key === "m") {
      video.muted = !video.muted;
      setMuted(video.muted);
    } else if (key === "c" && subtitles.length) {
      toggleCaptions();
    } else if (key === "f") {
      void toggleFullscreen();
    }
    revealControls();
  }

  const nativeUrl = file.playbackMode === "native" ? `${baseUrl}/stream` : undefined;
  const canSeek = duration > 0;
  const timelineTime = seekPreview ?? currentTime;
  const playedRatio = duration > 0 ? timelineTime / duration : 0;
  const subtitleGroups = subtitleDiscovery.preferences.enabledLanguages
    .map((language) => ({
      language,
      tracks: subtitles.filter((subtitle) => subtitle.language === language),
    }))
    .filter((group) => group.tracks.length > 0);
  const conversionLabel = playbackDetails
    ? `${playbackDetails.strategy === "remux" ? "Remuxing without video conversion" : "Converting to H.264 + AAC"} · ${playbackDetails.media.videoCodec}${playbackDetails.media.audioCodec ? ` / ${playbackDetails.media.audioCodec}` : ""}`
    : playbackState === "preparing"
      ? "Buffering torrent data, probing codecs, and preparing playback…"
      : "This source will be inspected and prepared when you press play.";

  return (
    <div className="playerStack">
      <div
        className={`videoPlayer ${subtitleStyleClass} ${controlsVisible ? "controlsVisible" : "controlsHidden"}`}
        ref={playerRef}
        tabIndex="0"
        role="group"
        aria-label={`${title} video player`}
        onKeyDown={handleKeyboard}
        onPointerMove={() => revealControls()}
        onPointerDown={() => revealControls()}
        onFocusCapture={() => revealControls()}
      >
        <video
          ref={videoRef}
          playsInline
          preload={file.playbackMode === "native" ? "auto" : "none"}
          src={nativeUrl}
          onClick={() => void togglePlayback()}
          onLoadStart={() => setPlaybackError("")}
          onLoadedMetadata={(event) => {
            const video = event.currentTarget;
            updateTimeline(video);
            if (
              file.playbackMode === "native"
              && !initialSeekAppliedRef.current
              && initialPosition > 0
              && initialPosition < video.duration
            ) {
              initialSeekAppliedRef.current = true;
              video.currentTime = initialPosition;
            }
          }}
          onDurationChange={(event) => updateTimeline(event.currentTarget)}
          onTimeUpdate={(event) => updateTimeline(event.currentTarget)}
          onProgress={(event) => updateTimeline(event.currentTarget)}
          onPlay={() => {
            setPlaying(true);
            revealControls(true);
          }}
          onPause={() => {
            setPlaying(false);
            revealControls(false);
            if (!endedRef.current) void saveProgress();
          }}
          onPlaying={() => {
            setBuffering(false);
            setPlaybackHint("");
          }}
          onWaiting={() => setBuffering(true)}
          onCanPlay={() => setBuffering(false)}
          onSeeked={() => void saveProgress()}
          onEnded={(event) => handlePlaybackEnded(event.currentTarget)}
          onVolumeChange={(event) => {
            setVolume(event.currentTarget.volume);
            setMuted(event.currentTarget.muted);
          }}
          onError={() => {
            if (file.playbackMode === "transcode") {
              const mediaError = videoRef.current?.error;
              const hls = hlsRef.current;
              if (mediaError?.code === 3 && hls && !recoveryRef.current.media) {
                recoveryRef.current.media = true;
                hls.recoverMediaError();
              } else {
                void reportPlayerFailure(mediaErrorMessage(mediaError));
              }
            } else {
              setPlaybackError("The browser could not play this video. Try another source.");
            }
          }}
        >
          {subtitles.map((subtitle) => (
            <track
              key={`${subtitle.id}-${subtitleOffsetMs}`}
              kind="subtitles"
              src={`${subtitle.src}?offsetMs=${subtitleOffsetMs}`}
              srcLang={subtitle.language}
              label={subtitle.label}
              onLoad={(event) => {
                event.currentTarget.track.mode = subtitle.id === activeSubtitleId ? "showing" : "disabled";
                applySubtitleCuePosition(event.currentTarget.track, subtitleAppearance.bottomOffsetPercent);
                setSubtitleError("");
              }}
              onError={() => setSubtitleError(`${subtitle.label} subtitles could not be loaded.`)}
            />
          ))}
          Your browser does not support HTML5 video.
        </video>

        <div className="playerShade" aria-hidden="true" />
        <div className="playerTopBar">
          <strong>{title}</strong>
          <span className="playbackModeBadge">{file.playbackMode === "native" ? "Native" : "HLS"}</span>
        </div>

        <div className="playerCenter">
          {playbackState === "preparing" || buffering ? (
            <div className="playerSpinner" role="status" aria-label="Buffering" />
          ) : null}
          {playbackState !== "preparing" && !buffering && !playing ? (
            <button className="centerPlayButton" type="button" onClick={() => void togglePlayback()}>
              <Icon name="play" />
              <span className="srOnly">
                {file.playbackMode === "transcode" && ["idle", "failed"].includes(playbackState)
                  ? playbackState === "failed" ? "Retry playback" : "Prepare and play"
                  : "Play"}
              </span>
            </button>
          ) : null}
          {file.playbackMode === "transcode" && ["idle", "failed"].includes(playbackState) ? (
            <span className="prepareLabel">
              {playbackState === "failed" ? "Retry playback" : "Prepare & play"}
            </span>
          ) : null}
        </div>

        <div className="playerBottomBar">
          {menu === "captions" ? (
            <div className="playerMenu captionMenu" role="menu" aria-label="Subtitles">
              <span>Subtitles</span>
              <button className={activeSubtitleId === null ? "active" : ""} type="button" onClick={() => selectSubtitle(null)}>Off</button>
              {subtitleGroups.map((group) => (
                <div className="captionLanguage" key={group.language}>
                  <strong>{group.tracks[0].label}</strong>
                  {group.tracks.map((subtitle) => (
                    <button
                      className={activeSubtitleId === subtitle.id ? "active" : ""}
                      type="button"
                      role="menuitemradio"
                      aria-checked={activeSubtitleId === subtitle.id}
                      key={subtitle.id}
                      onClick={() => selectSubtitle(subtitle.id)}
                    >
                      <span>{activeSubtitleId === subtitle.id ? "✓ " : ""}{subtitle.source}</span>
                      <small>{subtitle.releaseName || subtitle.sources.join(" + ")}</small>
                    </button>
                  ))}
                </div>
              ))}
              {subtitleDiscovery.state === "loading" ? <small className="subtitleLoading">Searching subtitle providers…</small> : null}
              <div className="subtitleDelay">
                <span>Subtitle delay</span>
                <div>
                  <button type="button" onClick={() => setSubtitleDelay((value) => Math.max(-10, value - 0.5))}>−0.5s</button>
                  <output>{subtitleDelay > 0 ? "+" : ""}{subtitleDelay.toFixed(1)}s</output>
                  <button type="button" onClick={() => setSubtitleDelay((value) => Math.min(10, value + 0.5))}>+0.5s</button>
                </div>
                {subtitleDelay !== 0 ? <button type="button" onClick={() => setSubtitleDelay(0)}>Reset delay</button> : null}
              </div>
              <button
                className="subtitleAppearanceLink"
                type="button"
                onClick={() => setMenu("subtitleAppearance")}
              >
                Subtitle appearance <span aria-hidden="true">→</span>
              </button>
            </div>
          ) : null}
          {menu === "subtitleAppearance" ? (
            <div className="playerMenu captionMenu subtitleAppearanceMenu" aria-label="Subtitle appearance">
              <div className="subtitleMenuHeader">
                <button type="button" onClick={() => setMenu("captions")}>← Back</button>
                <strong>Appearance</strong>
              </div>
              <div
                className="subtitlePreview"
                aria-live="polite"
                style={{ "--subtitle-preview-offset": `${subtitleAppearance.bottomOffsetPercent * 0.7}px` }}
              >
                <span>Subtitle preview</span>
              </div>
              <label className="subtitleSetting">
                <span>Size</span>
                <select
                  value={subtitleAppearance.size}
                  onChange={(event) => updateSubtitleAppearance({ size: event.target.value })}
                >
                  <option value="small">Small</option>
                  <option value="medium">Medium</option>
                  <option value="large">Large</option>
                  <option value="extra-large">Extra Large</option>
                </select>
              </label>
              <label className="subtitleSetting">
                <span>Font</span>
                <select
                  value={subtitleAppearance.font}
                  onChange={(event) => updateSubtitleAppearance({ font: event.target.value })}
                >
                  <option value="sans">Sans Serif</option>
                  <option value="serif">Serif</option>
                  <option value="monospace">Monospace</option>
                </select>
              </label>
              <label className="subtitleSetting">
                <span>Text color</span>
                <select
                  value={subtitleAppearance.textColor}
                  onChange={(event) => updateSubtitleAppearance({ textColor: event.target.value })}
                >
                  <option value="white">White</option>
                  <option value="yellow">Yellow</option>
                  <option value="cyan">Cyan</option>
                </select>
              </label>
              <label className="subtitleSetting">
                <span>Edge style</span>
                <select
                  value={subtitleAppearance.edgeStyle}
                  onChange={(event) => updateSubtitleAppearance({ edgeStyle: event.target.value })}
                >
                  <option value="none">None</option>
                  <option value="shadow">Shadow</option>
                  <option value="outline">Outline</option>
                </select>
              </label>
              <label className="subtitleSetting rangeSetting">
                <span>Background opacity <output>{subtitleAppearance.backgroundOpacity}%</output></span>
                <input
                  type="range"
                  min="0"
                  max="100"
                  step="25"
                  value={subtitleAppearance.backgroundOpacity}
                  onChange={(event) => updateSubtitleAppearance({ backgroundOpacity: Number(event.target.value) })}
                />
              </label>
              <label className="subtitleSetting rangeSetting">
                <span>Height from bottom <output>{subtitleAppearance.bottomOffsetPercent}%</output></span>
                <input
                  type="range"
                  min="5"
                  max="35"
                  step="5"
                  value={subtitleAppearance.bottomOffsetPercent}
                  onChange={(event) => updateSubtitleAppearance({ bottomOffsetPercent: Number(event.target.value) })}
                />
              </label>
              <button
                className="resetSubtitleAppearance"
                type="button"
                disabled={JSON.stringify(subtitleAppearance) === JSON.stringify(SUBTITLE_APPEARANCE_DEFAULTS)}
                onClick={resetSubtitleAppearance}
              >
                Reset appearance
              </button>
            </div>
          ) : null}
          {menu === "settings" ? (
            <div className="playerMenu speedMenu" role="menu" aria-label="Playback speed">
              <span>Playback speed</span>
              {[0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => (
                <button
                  className={playbackRate === rate ? "active" : ""}
                  type="button"
                  role="menuitemradio"
                  aria-checked={playbackRate === rate}
                  key={rate}
                  onClick={() => {
                    if (videoRef.current) videoRef.current.playbackRate = rate;
                    setPlaybackRate(rate);
                    setMenu(null);
                    revealControls(playing);
                  }}
                >
                  {rate === 1 ? "Normal" : `${rate}×`}
                </button>
              ))}
            </div>
          ) : null}

          <div className="playerTimeline">
            <div className="timelineTrack" aria-hidden="true">
              {bufferedRanges.map((range) => (
                <span
                  className="timelineBuffered"
                  key={`${range.start}-${range.end}`}
                  style={{
                    left: `${duration ? range.start / duration * 100 : 0}%`,
                    width: `${duration ? (range.end - range.start) / duration * 100 : 0}%`,
                  }}
                />
              ))}
              <span className="timelinePlayed" style={{ width: `${playedRatio * 100}%` }} />
            </div>
            <input
              className="playerSeek"
              type="range"
              min="0"
              max={duration || 1}
              step="0.1"
              value={Math.min(timelineTime, duration || 1)}
              disabled={!canSeek}
              aria-label="Seek"
              onChange={(event) => requestSeek(event.target.value)}
            />
          </div>

          <div className="playerControls">
            <div className="controlGroup">
              <button type="button" aria-label={playing ? "Pause" : "Play"} onClick={() => void togglePlayback()}>
                <Icon name={playing ? "pause" : "play"} />
              </button>
              <button
                type="button"
                aria-label={muted ? "Unmute" : "Mute"}
                onClick={() => {
                  if (!videoRef.current) return;
                  videoRef.current.muted = !videoRef.current.muted;
                  setMuted(videoRef.current.muted);
                }}
              >
                <Icon name={muted || volume === 0 ? "muted" : "volume"} />
              </button>
              <input
                className="volumeSlider"
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={muted ? 0 : volume}
                aria-label="Volume"
                onChange={(event) => {
                  const next = Number(event.target.value);
                  if (!videoRef.current) return;
                  videoRef.current.volume = next;
                  videoRef.current.muted = false;
                  setVolume(next);
                  setMuted(false);
                }}
              />
              <span className="playerTime">{formatTime(timelineTime)} / {duration ? formatTime(duration) : "--:--"}</span>
            </div>
            <div className="controlGroup">
              <button
                className={activeSubtitleId !== null ? "active" : ""}
                type="button"
                aria-label="Subtitles"
                aria-expanded={menu === "captions" || menu === "subtitleAppearance"}
                disabled={subtitles.length === 0}
                onClick={() => {
                  clearTimeout(hideTimerRef.current);
                  setControlsVisible(true);
                  setMenu(menu === "captions" || menu === "subtitleAppearance" ? null : "captions");
                }}
              >
                <span className="ccIcon">CC</span>
              </button>
              <button
                className={menu === "settings" ? "active" : ""}
                type="button"
                aria-label="Playback settings"
                aria-expanded={menu === "settings"}
                onClick={() => {
                  clearTimeout(hideTimerRef.current);
                  setControlsVisible(true);
                  setMenu(menu === "settings" ? null : "settings");
                }}
              >
                <Icon name="settings" />
              </button>
              {pipSupported ? (
                <button type="button" aria-label="Picture in picture" onClick={() => void togglePictureInPicture()}>
                  <Icon name="pip" />
                </button>
              ) : null}
              {fullscreenSupported ? (
                <button type="button" aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"} onClick={() => void toggleFullscreen()}>
                  <Icon name={isFullscreen ? "compress" : "fullscreen"} />
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      {file.playbackMode === "transcode" ? <div className="conversionNotice">{conversionLabel}</div> : null}
      {subtitleError ? <div className="notice error" role="alert">{subtitleError}</div> : null}
      {playbackError ? <div className="notice error" role="alert">{playbackError}</div> : null}
      {playbackHint ? <div className="notice">{playbackHint}</div> : null}
      {progressError ? <div className="notice">Watch progress unavailable: {progressError}</div> : null}
    </div>
  );
}
