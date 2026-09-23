"use client";

import Hls from "hls.js";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  normalizeSubtitleAppearance,
  readSubtitleAppearance,
  SUBTITLE_APPEARANCE_DEFAULTS,
  subtitleAppearanceClassName,
  writeSubtitleAppearance,
} from "../lib/subtitles/appearance.js";
import { automaticSubtitleId } from "../lib/subtitles/selection.js";
import {
  activeSubtitleCues,
  subscribeToSubtitleTrack,
} from "../lib/subtitles/timeline.js";
import { PROGRESS_SAVE_INTERVAL_MS } from "../lib/history/constants.js";
import { isPlaybackAtEnd, shouldOfferNextEpisode } from "../lib/playback/autoplay.js";
import { isRemotePlaybackSessionActive } from "../lib/remote-playback/client-state.js";
import { remotePlaybackSource } from "../lib/remote-playback/source.js";
import {
  isFullscreenActive,
  lockFullscreenViewport,
  supportsFullscreen,
  toggleBrowserFullscreen,
} from "../lib/video/fullscreen.js";
import { closesPlayerMenu, nextMenuIndex } from "../lib/video/menu-navigation.js";
import { useRemotePlayback } from "./useRemotePlayback.js";

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

function SubtitleCue({ cue }) {
  const cueRef = useRef(null);

  useEffect(() => {
    const element = cueRef.current;
    if (!element) return;
    if (typeof cue?.getCueAsHTML === "function") {
      element.replaceChildren(cue.getCueAsHTML());
    } else {
      element.textContent = String(cue?.text || "");
    }
  }, [cue]);

  return <span ref={cueRef} />;
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
    cast: <path d="M3 18v3h3a3 3 0 0 0-3-3zm0-5v2a6 6 0 0 1 6 6h2a8 8 0 0 0-8-8zm0-5v2c6.08 0 11 4.92 11 11h2C16 13.82 10.18 8 3 8zm2-5a2 2 0 0 0-2 2v5h2V5h14v10h-6v2h6a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2H5z" />,
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
  const captionMenuRef = useRef(null);
  const captionButtonRef = useRef(null);
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
  const castWasActiveRef = useRef(false);
  const remoteOriginRef = useRef(null);
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
  const [subtitleCues, setSubtitleCues] = useState({});
  const [subtitleDelay, setSubtitleDelay] = useState(0);
  const [subtitleAppearance, setSubtitleAppearance] = useState(SUBTITLE_APPEARANCE_DEFAULTS);
  const [subtitleDiscovery, setSubtitleDiscovery] = useState({
    state: "loading",
    preferences: { defaultLanguage: "en", enabledLanguages: ["en", "mk", "sr", "hr", "bs"] },
    providers: {},
    tracks: [],
  });
  const [playbackRate, setPlaybackRate] = useState(1);
  const [browserFullscreen, setBrowserFullscreen] = useState(false);
  const [viewportFullscreen, setViewportFullscreen] = useState(false);
  const [fullscreenSupported, setFullscreenSupported] = useState(false);
  const [pipSupported, setPipSupported] = useState(false);
  const [progressError, setProgressError] = useState("");
  const [writerToken, setWriterToken] = useState(null);
  const remotePlayback = useRemotePlayback(videoRef);
  const baseUrl = `/api/torrents/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(file.id)}`;
  const playbackUrl = `${baseUrl}/playback`;
  const subtitles = subtitleDiscovery.tracks;
  const subtitleUrl = `${baseUrl}/subtitles`;
  const subtitleStyleClass = subtitleAppearanceClassName(subtitleAppearance);
  const isFullscreen = browserFullscreen || viewportFullscreen;

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

  async function getRemoteOrigin() {
    if (remoteOriginRef.current) return remoteOriginRef.current;
    const response = await fetch("/api/playback/remote", { cache: "no-store" });
    const payload = await responseJson(response);
    if (!response.ok || !payload?.origin) {
      throw new Error(payload?.error || "TorPlay could not determine its local-network address.");
    }
    remoteOriginRef.current = payload.origin;
    return payload.origin;
  }

  async function prepareRemoteSource(startTime = timelineRef.current.position) {
    const origin = await getRemoteOrigin();
    let mediaPath = `${baseUrl}/stream`;
    let contentType = file.mimeType;
    let originSeconds = 0;
    let receiverStartTime = Math.max(0, Number(startTime) || 0);
    let sourceDuration = timelineRef.current.duration;
    let mode = "direct";

    if (file.playbackMode === "transcode") {
      const response = await fetch(playbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startTime: receiverStartTime }),
      });
      const payload = await responseJson(response);
      if (!response.ok) {
        throw new Error(payload?.error || `Remote playback preparation failed with HTTP ${response.status}.`);
      }
      if (!payload?.manifestUrl) throw new Error("The server did not return a remote HLS playlist.");
      preparedRef.current = true;
      setPlaybackDetails(payload);
      startPolling();
      mediaPath = payload.manifestUrl;
      contentType = "application/vnd.apple.mpegurl";
      originSeconds = payload.originSeconds || 0;
      receiverStartTime = 0;
      sourceDuration = payload.duration || payload.media?.duration || sourceDuration;
      mode = "hls";
    }

    return remotePlaybackSource({
      origin,
      sessionId,
      mediaPath,
      contentType,
      title,
      posterUrl: media?.posterUrl || null,
      duration: sourceDuration,
      originSeconds,
      receiverStartTime,
      mode,
      subtitles,
      activeSubtitleId,
    });
  }

  useEffect(() => {
    setPipSupported(Boolean(document.pictureInPictureEnabled && videoRef.current?.requestPictureInPicture));
    const video = videoRef.current;
    const updateFullscreenState = () => {
      setBrowserFullscreen(isFullscreenActive(document, playerRef.current, video));
    };
    const updateFullscreenSupport = () => {
      setFullscreenSupported(supportsFullscreen(playerRef.current, { viewportFallback: true }));
    };
    const onNativeFullscreenBegin = () => setBrowserFullscreen(true);
    const onNativeFullscreenEnd = () => setBrowserFullscreen(false);

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
    if (!viewportFullscreen) return undefined;
    const unlockViewport = lockFullscreenViewport(document);
    const exitOnEscape = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setViewportFullscreen(false);
    };

    document.addEventListener("keydown", exitOnEscape);

    return () => {
      document.removeEventListener("keydown", exitOnEscape);
      unlockViewport();
    };
  }, [viewportFullscreen]);

  useEffect(() => {
    const cast = remotePlayback.castState;
    const video = videoRef.current;
    if (cast.active) {
      if (!castWasActiveRef.current) {
        video?.pause();
        hlsRef.current?.destroy();
        hlsRef.current = null;
        initialSeekAppliedRef.current = true;
      }
      const nextDuration = cast.duration || timelineRef.current.duration;
      timelineRef.current = { position: cast.position, duration: nextDuration };
      if (!nearEndNotifiedRef.current && shouldOfferNextEpisode(cast.position, nextDuration)) {
        nearEndNotifiedRef.current = true;
        onNearEnd?.({ position: cast.position, duration: nextDuration });
      }
      if (!endedRef.current && isPlaybackAtEnd(cast.position, nextDuration)) {
        endedRef.current = true;
        void saveProgress({ position: nextDuration, duration: nextDuration }).finally(() => onEnded?.());
      }
    } else if (castWasActiveRef.current) {
      if (file.playbackMode === "native" && video && timelineRef.current.position < video.duration) {
        video.currentTime = timelineRef.current.position;
      } else if (file.playbackMode === "transcode") {
        hlsRef.current?.destroy();
        hlsRef.current = null;
        video?.removeAttribute("src");
        video?.load();
      }
    }
    castWasActiveRef.current = cast.active;
  }, [
    file.playbackMode,
    onEnded,
    onNearEnd,
    remotePlayback.castState,
    saveProgress,
  ]);

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
        const response = await fetch(subtitleUrl, {
          method,
          cache: "no-store",
          ...(method === "POST" ? {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ profileId }),
          } : {}),
        });
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
  }, [profileId, subtitleUrl]);

  useEffect(() => {
    const video = videoRef.current;
    const elements = Array.from(video?.querySelectorAll("track") || []);
    const cleanups = [];

    subtitles.forEach((subtitle, index) => {
      const element = elements[index];
      if (!element) return;

      cleanups.push(subscribeToSubtitleTrack(element, {
        mode: subtitle.id === activeSubtitleId ? "hidden" : "disabled",
        onCues: (cues) => {
          setSubtitleCues((current) => ({ ...current, [subtitle.id]: cues }));
          setSubtitleError("");
        },
        onError: () => {
          setSubtitleError(`${subtitle.label} subtitles could not be loaded.`);
        },
      }));
    });

    return () => cleanups.forEach((cleanup) => cleanup());
  }, [activeSubtitleId, subtitles]);

  useEffect(() => () => {
    abortRef.current?.abort();
    stopPolling();
    hlsRef.current?.destroy();
    clearTimeout(hideTimerRef.current);
    clearTimeout(seekTimerRef.current);
    if (preparedRef.current && !isRemotePlaybackSessionActive(sessionId)) {
      void fetch(playbackUrl, { method: "DELETE", keepalive: true });
    }
    void saveProgress({ keepalive: true });
  }, [playbackUrl, saveProgress, sessionId]);

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
    if (remotePlayback.castState.active) {
      remotePlayback.toggleCastPlayback();
      return;
    }
    const video = videoRef.current;
    if (!video) return;
    if (
      file.playbackMode === "transcode"
      && (["idle", "failed"].includes(playbackState) || !hlsRef.current)
    ) {
      await preparePlayback(initialSeekAppliedRef.current ? effectiveCurrentTime : initialPosition);
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
    const returnFocus = menu === "captions";
    if (manual) {
      subtitleSelectionModeRef.current = "user";
    }
    activeSubtitleRef.current = id;
    setActiveSubtitleId(id);
    setSubtitleError("");
    setMenu(null);
    if (returnFocus) captionButtonRef.current?.focus({ preventScroll: true });
    revealControls(playing);
  }

  function closeCaptionMenu() {
    setMenu(null);
    captionButtonRef.current?.focus({ preventScroll: true });
    revealControls(playing);
  }

  function captionMenuItems() {
    return Array.from(captionMenuRef.current?.querySelectorAll("[data-player-menu-item]:not(:disabled)") || []);
  }

  function focusCaptionMenuItem(item) {
    item?.focus({ preventScroll: true });
    item?.scrollIntoView({ block: "nearest" });
  }

  function handleCaptionMenuKeyDown(event) {
    if (closesPlayerMenu(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      closeCaptionMenu();
      return;
    }
    const items = captionMenuItems();
    const nextIndex = nextMenuIndex(items.indexOf(document.activeElement), items.length, event.key);
    if (nextIndex < 0) return;
    event.preventDefault();
    event.stopPropagation();
    focusCaptionMenuItem(items[nextIndex]);
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
    if (!effectiveDuration) return;
    const next = Math.max(0, Math.min(effectiveDuration, Number(target)));
    setSeekPreview(next);
    clearTimeout(seekTimerRef.current);
    if (remotePlayback.castState.active) {
      const commitRemoteSeek = async () => {
        setBuffering(true);
        await remotePlayback.seekCast(next, prepareRemoteSource);
        setSeekPreview(null);
        setBuffering(false);
      };
      seekTimerRef.current = setTimeout(() => void commitRemoteSeek(), immediate ? 0 : 300);
      return;
    }
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
      await toggleBrowserFullscreen(document, playerRef.current, {
        viewportActive: viewportFullscreen,
        enterViewport: () => setViewportFullscreen(true),
        exitViewport: () => setViewportFullscreen(false),
      });
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
    } else if (key === "arrowleft" && effectiveDuration) {
      event.preventDefault();
      requestSeek(effectiveCurrentTime - 10, true);
    } else if (key === "arrowright" && effectiveDuration) {
      event.preventDefault();
      requestSeek(effectiveCurrentTime + 10, true);
    } else if (key === "arrowup" || key === "arrowdown") {
      event.preventDefault();
      const currentVolume = remotePlayback.castState.active
        ? remotePlayback.castState.volume
        : video.volume;
      const nextVolume = Math.min(1, Math.max(0, currentVolume + (key === "arrowup" ? 0.05 : -0.05)));
      if (remotePlayback.castState.active) remotePlayback.setCastVolume(nextVolume);
      else {
        video.volume = nextVolume;
        video.muted = false;
      }
      setVolume(nextVolume);
      setMuted(false);
    } else if (key === "m") {
      if (remotePlayback.castState.active) {
        remotePlayback.toggleCastMute();
        setMuted(!remotePlayback.castState.muted);
      } else {
        video.muted = !video.muted;
        setMuted(video.muted);
      }
    } else if (key === "c" && subtitles.length) {
      toggleCaptions();
    } else if (key === "f") {
      void toggleFullscreen();
    }
    revealControls();
  }

  const nativeUrl = file.playbackMode === "native" ? `${baseUrl}/stream` : undefined;
  const effectivePlaying = remotePlayback.castState.active ? remotePlayback.castState.playing : playing;
  const effectiveBuffering = remotePlayback.castState.active ? remotePlayback.castBusy : buffering;
  const effectiveCurrentTime = remotePlayback.castState.active
    ? remotePlayback.castState.position
    : currentTime;
  const effectiveDuration = remotePlayback.castState.active
    ? remotePlayback.castState.duration || duration
    : duration;
  const effectiveMuted = remotePlayback.castState.active ? remotePlayback.castState.muted : muted;
  const effectiveVolume = remotePlayback.castState.active ? remotePlayback.castState.volume : volume;
  const canSeek = effectiveDuration > 0;
  const timelineTime = seekPreview ?? effectiveCurrentTime;
  const playedRatio = effectiveDuration > 0 ? timelineTime / effectiveDuration : 0;
  const visibleSubtitleCues = remotePlayback.castState.active || playbackState === "preparing" || activeSubtitleId === null
    ? []
    : activeSubtitleCues(subtitleCues[activeSubtitleId], effectiveCurrentTime, subtitleDelay);
  const subtitleGroups = subtitleDiscovery.preferences.enabledLanguages
    .map((language) => ({
      language,
      tracks: subtitles.filter((subtitle) => subtitle.language === language),
    }))
    .filter((group) => group.tracks.length > 0);

  useEffect(() => {
    if (menu !== "captions") return;
    const items = captionMenuItems();
    const active = items.find((item) => item.getAttribute("aria-checked") === "true");
    focusCaptionMenuItem(active || items[0]);
  }, [activeSubtitleId, menu, subtitles.length]);

  const conversionLabel = playbackDetails
    ? `${playbackDetails.strategy === "remux" ? "Remuxing without video conversion" : "Converting to H.264 + AAC"} · ${playbackDetails.media.videoCodec}${playbackDetails.media.audioCodec ? ` / ${playbackDetails.media.audioCodec}` : ""}`
    : playbackState === "preparing"
      ? "Buffering torrent data, probing codecs, and preparing playback…"
      : "This source will be inspected and prepared when you press play.";

  return (
    <div className="playerStack">
      <div
        className={`videoPlayer ${subtitleStyleClass} ${controlsVisible ? "controlsVisible" : "controlsHidden"} ${viewportFullscreen ? "viewportFullscreen" : ""}`}
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
          x-webkit-airplay="allow"
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
              key={subtitle.id}
              kind="subtitles"
              src={subtitle.src}
              srcLang={subtitle.language}
              label={subtitle.label}
            />
          ))}
          Your browser does not support HTML5 video.
        </video>

        {visibleSubtitleCues.length > 0 ? (
          <div
            className="subtitleOverlay"
            aria-live="off"
            style={{ "--subtitle-bottom-offset": `${subtitleAppearance.bottomOffsetPercent}%` }}
          >
            {visibleSubtitleCues.map((cue, index) => (
              <SubtitleCue cue={cue} key={`${cue.startTime}-${cue.endTime}-${index}`} />
            ))}
          </div>
        ) : null}

        <div className="playerShade" aria-hidden="true" />
        <div className="playerTopBar">
          <strong>{title}</strong>
          <span className="playbackModeBadge">
            {remotePlayback.castState.active
              ? `Playing on ${remotePlayback.castState.deviceName}`
              : remotePlayback.airPlayActive ? "Playing with AirPlay" : file.playbackMode === "native" ? "Native" : "HLS"}
          </span>
        </div>

        <div className="playerCenter">
          {playbackState === "preparing" || effectiveBuffering ? (
            <div className="playerSpinner" role="status" aria-label="Buffering" />
          ) : null}
          {playbackState !== "preparing" && !effectiveBuffering && !effectivePlaying ? (
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
            <div
              className="playerMenu captionMenu"
              id="subtitle-menu"
              role="menu"
              aria-label="Subtitles"
              ref={captionMenuRef}
              onKeyDown={handleCaptionMenuKeyDown}
            >
              <div className="captionMenuHeader">
                <span>Subtitles</span>
                <button
                  className={activeSubtitleId === null ? "active" : ""}
                  type="button"
                  role="menuitemradio"
                  aria-checked={activeSubtitleId === null}
                  data-player-menu-item
                  onClick={() => selectSubtitle(null)}
                >
                  {activeSubtitleId === null ? "✓ " : ""}Off
                </button>
              </div>
              <div className="captionTrackList">
                {subtitleGroups.map((group) => (
                  <div className="captionLanguage" role="group" aria-label={group.tracks[0].label} key={group.language}>
                    <strong>{group.tracks[0].label}</strong>
                    {group.tracks.map((subtitle) => (
                      <button
                        className={activeSubtitleId === subtitle.id ? "active" : ""}
                        type="button"
                        role="menuitemradio"
                        aria-checked={activeSubtitleId === subtitle.id}
                        data-player-menu-item
                        key={subtitle.id}
                        onClick={() => selectSubtitle(subtitle.id)}
                      >
                        <span>{activeSubtitleId === subtitle.id ? "✓ " : ""}{subtitle.source}</span>
                        <small>{subtitle.releaseName || subtitle.sources.join(" + ")}</small>
                      </button>
                    ))}
                  </div>
                ))}
              </div>
              <div className="captionMenuFooter">
                {subtitleDiscovery.state === "loading" ? <small className="subtitleLoading">Searching subtitle providers…</small> : null}
                <div className="subtitleDelay">
                  <span>Subtitle delay</span>
                  <div>
                    <button data-player-menu-item type="button" onClick={() => setSubtitleDelay((value) => Math.max(-10, value - 0.5))}>−0.5s</button>
                    <output>{subtitleDelay > 0 ? "+" : ""}{subtitleDelay.toFixed(1)}s</output>
                    <button data-player-menu-item type="button" onClick={() => setSubtitleDelay((value) => Math.min(10, value + 0.5))}>+0.5s</button>
                  </div>
                  {subtitleDelay !== 0 ? <button data-player-menu-item type="button" onClick={() => setSubtitleDelay(0)}>Reset delay</button> : null}
                </div>
                <button
                  className="subtitleAppearanceLink"
                  type="button"
                  data-player-menu-item
                  onClick={() => setMenu("subtitleAppearance")}
                >
                  Subtitle appearance <span aria-hidden="true">→</span>
                </button>
              </div>
            </div>
          ) : null}
          {menu === "subtitleAppearance" ? (
            <div className="playerMenu captionMenu subtitleAppearanceMenu" id="subtitle-menu" aria-label="Subtitle appearance">
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
          {menu === "remote" ? (
            <div className="playerMenu remotePlaybackMenu" aria-label="Remote playback">
              <span>Play on another screen</span>
              {remotePlayback.castState.active ? (
                <>
                  <div className="remoteDeviceStatus">
                    <strong>{remotePlayback.castState.deviceName}</strong>
                    <small>{remotePlayback.castBusy ? "Connecting…" : effectivePlaying ? "Playing" : "Paused"}</small>
                  </div>
                  <button className="remoteStopButton" type="button" onClick={remotePlayback.stopCast}>
                    Stop casting
                  </button>
                </>
              ) : (
                <>
                  {remotePlayback.castAvailable ? (
                    <button
                      type="button"
                      disabled={remotePlayback.castBusy}
                      onClick={() => void remotePlayback.startCast(
                        () => prepareRemoteSource(timelineRef.current.position),
                      )}
                    >
                      {remotePlayback.castBusy ? "Connecting to Google Cast…" : "Google Cast"}
                    </button>
                  ) : null}
                  {remotePlayback.airPlayAvailable ? (
                    <button
                      type="button"
                      disabled={file.playbackMode === "transcode" && playbackState !== "ready"}
                      onClick={remotePlayback.showAirPlayPicker}
                    >
                      AirPlay
                    </button>
                  ) : null}
                </>
              )}
              <small className="remotePlaybackNote">
                The selected device streams directly from this TorPlay server.
              </small>
            </div>
          ) : null}

          <div className="playerTimeline">
            <div className="timelineTrack" aria-hidden="true">
              {bufferedRanges.map((range) => (
                <span
                  className="timelineBuffered"
                  key={`${range.start}-${range.end}`}
                  style={{
                    left: `${effectiveDuration ? range.start / effectiveDuration * 100 : 0}%`,
                    width: `${effectiveDuration ? (range.end - range.start) / effectiveDuration * 100 : 0}%`,
                  }}
                />
              ))}
              <span className="timelinePlayed" style={{ width: `${playedRatio * 100}%` }} />
            </div>
            <input
              className="playerSeek"
              type="range"
              min="0"
              max={effectiveDuration || 1}
              step="0.1"
              value={Math.min(timelineTime, effectiveDuration || 1)}
              disabled={!canSeek}
              aria-label="Seek"
              onChange={(event) => requestSeek(event.target.value)}
            />
          </div>

          <div className="playerControls">
            <div className="controlGroup">
              <button type="button" aria-label={effectivePlaying ? "Pause" : "Play"} onClick={() => void togglePlayback()}>
                <Icon name={effectivePlaying ? "pause" : "play"} />
              </button>
              <button
                type="button"
                aria-label={effectiveMuted ? "Unmute" : "Mute"}
                onClick={() => {
                  if (remotePlayback.castState.active) {
                    remotePlayback.toggleCastMute();
                    setMuted(!remotePlayback.castState.muted);
                    return;
                  }
                  if (!videoRef.current) return;
                  videoRef.current.muted = !videoRef.current.muted;
                  setMuted(videoRef.current.muted);
                }}
              >
                <Icon name={effectiveMuted || effectiveVolume === 0 ? "muted" : "volume"} />
              </button>
              <input
                className="volumeSlider"
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={effectiveMuted ? 0 : effectiveVolume}
                aria-label="Volume"
                onChange={(event) => {
                  const next = Number(event.target.value);
                  if (remotePlayback.castState.active) {
                    remotePlayback.setCastVolume(next);
                    setVolume(next);
                    setMuted(false);
                    return;
                  }
                  if (!videoRef.current) return;
                  videoRef.current.volume = next;
                  videoRef.current.muted = false;
                  setVolume(next);
                  setMuted(false);
                }}
              />
              <span className="playerTime">{formatTime(timelineTime)} / {effectiveDuration ? formatTime(effectiveDuration) : "--:--"}</span>
            </div>
            <div className="controlGroup">
              <button
                className={activeSubtitleId !== null ? "active" : ""}
                ref={captionButtonRef}
                type="button"
                aria-label="Subtitles"
                aria-expanded={menu === "captions" || menu === "subtitleAppearance"}
                aria-controls="subtitle-menu"
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
              {remotePlayback.castAvailable || remotePlayback.airPlayAvailable || remotePlayback.castState.active ? (
                <button
                  className={menu === "remote" || remotePlayback.castState.active || remotePlayback.airPlayActive ? "active" : ""}
                  type="button"
                  aria-label="Remote playback"
                  aria-expanded={menu === "remote"}
                  onClick={() => {
                    clearTimeout(hideTimerRef.current);
                    setControlsVisible(true);
                    setMenu(menu === "remote" ? null : "remote");
                  }}
                >
                  <Icon name="cast" />
                </button>
              ) : null}
              {pipSupported && !remotePlayback.castState.active ? (
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
      {remotePlayback.error ? <div className="notice error" role="alert">Remote playback: {remotePlayback.error}</div> : null}
      {playbackError ? <div className="notice error" role="alert">{playbackError}</div> : null}
      {playbackHint ? <div className="notice">{playbackHint}</div> : null}
      {progressError ? <div className="notice">Watch progress unavailable: {progressError}</div> : null}
    </div>
  );
}
