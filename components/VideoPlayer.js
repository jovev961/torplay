"use client";

import Hls from "hls.js";
import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
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
import { isPlaybackAtEnd, shouldOfferNextEpisode, shouldShowUpNext } from "../lib/playback/autoplay.js";
import { activeSkipSegment, automaticSegment, segmentPlaybackRange, showManualSkip } from "../lib/playback/segment-controls.js";
import { isRemotePlaybackSessionActive } from "../lib/remote-playback/client-state.js";
import { remotePlaybackSource } from "../lib/remote-playback/source.js";
import {
  isFullscreenActive,
  lockFullscreenViewport,
  needsHomeScreenForImmersivePlayback,
  supportsFullscreen,
  toggleBrowserFullscreen,
} from "../lib/video/fullscreen.js";
import { closesPlayerMenu, nextMenuIndex } from "../lib/video/menu-navigation.js";
import { clampSeekTarget, seekHasArrived, skipTarget } from "../lib/video/seek-target.js";
import { waitForSynchronizedPosition } from "../lib/video/media-readiness.js";
import { detectClientCapabilities } from "../lib/video/client-capabilities.js";
import { codecLabel, playbackMediaBadges } from "../lib/video/media-capabilities.js";
import { nextPlaybackFallback } from "../lib/video/playback-recovery.js";
import { useRemotePlayback } from "./useRemotePlayback.js";
import { isSpecialAudioTrack, selectAudioTrack } from "../lib/video/audio-tracks.js";
import { useOptionalProfile } from "./ProfileProvider.js";
import { useOptionalI18n } from "./I18nProvider.js";
import { useOptionalWatchTogether } from "./WatchTogetherProvider.js";

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

function waitForCanPlay(video, { timeoutMs = 15_000, signal } = {}) {
  if (video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = timeoutMs === null ? null
      : setTimeout(() => finish(new Error("The local source did not become ready in time.")), timeoutMs);
    const onReady = () => finish();
    const onError = () => finish(new Error("The local source could not be played."));
    const onAbort = () => finish(signal.reason instanceof Error
      ? signal.reason : new DOMException("Playback preparation was replaced.", "AbortError"));
    function finish(error) {
      if (timer) clearTimeout(timer);
      video.removeEventListener("canplay", onReady);
      video.removeEventListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    }
    video.addEventListener("canplay", onReady, { once: true });
    video.addEventListener("error", onError, { once: true });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function pauseForSync(video) {
  if (video.paused) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onPause = () => finish();
    const onError = () => finish(new Error("The local player could not pause for synchronization."));
    function finish(error) {
      video.removeEventListener("pause", onPause);
      video.removeEventListener("error", onError);
      if (error) reject(error);
      else resolve();
    }
    video.addEventListener("pause", onPause, { once: true });
    video.addEventListener("error", onError, { once: true });
    video.pause();
    if (video.paused) queueMicrotask(onPause);
  });
}

async function playForSync(video) {
  try {
    await video.play();
    return;
  } catch (error) {
    if (error?.name !== "NotAllowedError" || video.muted) throw error;
  }

  // A transcoded seek replaces the MediaSource. Some browsers treat the new
  // source as a fresh autoplay attempt even though the user was already
  // watching. Muted playback is permitted; restore the viewer's own setting
  // immediately after playback has actually started.
  const wasMuted = video.muted;
  video.muted = true;
  try {
    await video.play();
  } catch (error) {
    video.muted = wasMuted;
    throw error;
  }
  video.muted = wasMuted;
}

function waitForDecodedFrame(video, { signal, timeoutMs = 30_000 } = {}) {
  const haveCurrentData = typeof HTMLMediaElement === "undefined"
    ? 2 : HTMLMediaElement.HAVE_CURRENT_DATA;
  const ready = () => !video.seeking && video.readyState >= haveCurrentData;
  if (ready()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const events = ["loadeddata", "canplay", "seeked", "torplayhlsbuffered"];
    const timer = setTimeout(() => finish(new Error("The local source did not buffer the shared position in time.")), timeoutMs);
    const onReady = (event) => {
      if (video.seeking) return;
      // loadeddata/canplay are the media element's decoded-frame signals. For
      // hls.js, FRAG_BUFFERED confirms that the requested starting fragment is
      // appended and can be played even when the paused element has not yet
      // advanced its readyState.
      if (ready() || event?.type === "loadeddata" || event?.type === "canplay"
        || event?.type === "torplayhlsbuffered") finish();
    };
    const onError = () => finish(new Error("The local source could not load the shared position."));
    const onAbort = () => finish(signal.reason instanceof Error
      ? signal.reason : new DOMException("Playback preparation was replaced.", "AbortError"));
    function finish(error) {
      clearTimeout(timer);
      for (const event of events) video.removeEventListener(event, onReady);
      video.removeEventListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    }
    for (const event of events) video.addEventListener(event, onReady);
    video.addEventListener("error", onError, { once: true });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    else queueMicrotask(onReady);
  });
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
    previous: <path d="M5 5h2v14H5V5zm14 0v14L8 12l11-7z" />,
    next: <path d="M17 5h2v14h-2V5zM5 5l11 7-11 7V5z" />,
    cast: <path d="M3 18v3h3a3 3 0 0 0-3-3zm0-5v2a6 6 0 0 1 6 6h2a8 8 0 0 0-8-8zm0-5v2c6.08 0 11 4.92 11 11h2C16 13.82 10.18 8 3 8zm2-5a2 2 0 0 0-2 2v5h2V5h14v10h-6v2h6a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2H5z" />,
    settings: <path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zm9 4.8v-2.6l-2.1-.6a7 7 0 0 0-.7-1.6l1.1-1.9-1.9-1.9-1.9 1.1a7 7 0 0 0-1.6-.7L13.3 3h-2.6l-.6 2.1a7 7 0 0 0-1.6.7L6.6 4.7 4.7 6.6l1.1 1.9a7 7 0 0 0-.7 1.6l-2.1.6v2.6l2.1.6a7 7 0 0 0 .7 1.6l-1.1 1.9 1.9 1.9 1.9-1.1a7 7 0 0 0 1.6.7l.6 2.1h2.6l.6-2.1a7 7 0 0 0 1.6-.7l1.9 1.1 1.9-1.9-1.1-1.9a7 7 0 0 0 .7-1.6l2.1-.6z" />,
    together: <path d="M8.5 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zm7-1a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM8.5 13C4.36 13 2 15.04 2 18v2h13v-2c0-2.96-2.36-5-6.5-5zm7 0c-.5 0-.96.04-1.4.11A6.2 6.2 0 0 1 17 18v2h5v-2c0-3-2.3-5-6.5-5z" />,
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
  autoStart = false,
  onNearEnd = null,
  onEnded = null,
  onPreviousEpisode = null,
  onNextEpisode = null,
  hasPreviousEpisode = false,
  hasNextEpisode = false,
  suspended = false,
  sourcePicker = null,
  nextEpisodePrompt = null,
  playbackPreferences = { autoSkipIntrosRecaps: false, autoPlayNextEpisode: false },
  onPlaybackPreferencesChange = null,
}) {
  const playerRef = useRef(null);
  const videoRef = useRef(null);
  const captionMenuRef = useRef(null);
  const captionButtonRef = useRef(null);
  const audioButtonRef = useRef(null);
  const sourcePickerRef = useRef(null);
  const episodePromptRef = useRef(null);
  const skipButtonRef = useRef(null);
  const autoSkippedRef = useRef(new Set());
  const hlsRef = useRef(null);
  const playbackReadyAbortRef = useRef(null);
  const abortRef = useRef(null);
  const pollRef = useRef(null);
  const hideTimerRef = useRef(null);
  const seekTimerRef = useRef(null);
  const seekTargetRef = useRef(null);
  const playbackGenerationRef = useRef(0);
  const sourceIdentityRef = useRef(null);
  const touchTapRef = useRef(null);
  const tapTimerRef = useRef(null);
  const feedbackTimerRef = useRef(null);
  const suppressTouchClickRef = useRef(false);
  const subtitleChoiceRef = useRef(null);
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
  const castTransitionRef = useRef(false);
  const remoteOriginRef = useRef(null);
  const playWhenReadyRef = useRef(true);
  const failedStrategiesRef = useRef([]);
  const failedAudioCodecsRef = useRef([]);
  const [playbackError, setPlaybackError] = useState("");
  const [subtitleError, setSubtitleError] = useState("");
  const [playbackHint, setPlaybackHint] = useState("");
  const [playbackState, setPlaybackState] = useState("inspecting");
  const [playbackDetails, setPlaybackDetails] = useState(null);
  const [clientCapabilities, setClientCapabilities] = useState(null);
  const [audioInspection, setAudioInspection] = useState("loading");
  const [audioTracks, setAudioTracks] = useState([]);
  const [selectedAudioStreamIndex, setSelectedAudioStreamIndex] = useState(null);
  const [audioError, setAudioError] = useState("");
  const [savingAudioPreference, setSavingAudioPreference] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [bufferedRanges, setBufferedRanges] = useState([]);
  const [seekPreview, setSeekPreview] = useState(null);
  const [skipFeedback, setSkipFeedback] = useState(null);
  const [segments, setSegments] = useState({ intro: null, recap: null, outro: null, preview: null });
  const [segmentSourceIdentity, setSegmentSourceIdentity] = useState(null);
  const [countdownRemaining, setCountdownRemaining] = useState(null);
  const [settingsError, setSettingsError] = useState("");
  const [savingSetting, setSavingSetting] = useState(false);
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
  const [homeScreenHintVisible, setHomeScreenHintVisible] = useState(false);
  const [fullscreenSupported, setFullscreenSupported] = useState(false);
  const [pipSupported, setPipSupported] = useState(false);
  const [progressError, setProgressError] = useState("");
  const [writerToken, setWriterToken] = useState(null);
  const profileContext = useOptionalProfile();
  const i18n = useOptionalI18n();
  const watchTogether = useOptionalWatchTogether();
  const activeProfile = profileContext?.activeProfile || null;
  const updateAudioPreferences = profileContext?.updateAudioPreferences;
  const displayLanguage = i18n?.displayLanguage || ((code) => {
    try { return new Intl.DisplayNames(["en"], { type: "language" }).of(code) || code; }
    catch { return code; }
  });
  const t = i18n?.t || ((message, values = {}) => String(message).replace(/\{(\w+)\}/g,
    (match, name) => Object.hasOwn(values, name) ? String(values[name]) : match));
  const remotePlayback = useRemotePlayback(videoRef);
  const baseUrl = `/api/torrents/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(file.id)}`;
  const playbackUrl = `${baseUrl}/playback`;
  const sourceIdentity = [sessionId, file.id, profileId || "guest", media?.mediaType || "media",
    media?.tmdbId || "unknown", media?.seasonNumber ?? -1, media?.episodeNumber ?? -1].join(":");
  const currentSegments = segmentSourceIdentity === sourceIdentity ? segments
    : { intro: null, recap: null, outro: null, preview: null };
  const preferredAudioLanguage = activeProfile?.id === profileId
    ? activeProfile.audioPreferences?.preferredLanguage || "original" : "original";
  const requiresPreparedPlayback = playbackDetails?.delivery !== "direct";
  const selectedAudioTrack = audioTracks.find((track) => track.index === selectedAudioStreamIndex) || null;
  const subtitles = subtitleDiscovery.tracks;
  const subtitleUrl = `${baseUrl}/subtitles`;
  const subtitleStyleClass = subtitleAppearanceClassName(subtitleAppearance);
  const isFullscreen = browserFullscreen || viewportFullscreen;
  const segmentDuration = requiresPreparedPlayback
    ? Number(playbackDetails?.duration || playbackDetails?.media?.duration) : duration;
  const segmentDurationRounded = Math.round(segmentDuration);
  const watchTogetherActive = Boolean(media && watchTogether?.matchesMedia(media));
  const watchTogetherTransportLocked = watchTogetherActive
    && (watchTogether.isGuest || !watchTogether.allReady);
  const watchTogetherPlaybackLocked = watchTogetherTransportLocked
    || (watchTogetherActive && watchTogether.seekSyncing);
  const attachWatchTogetherPlayer = watchTogether?.attachPlayer;

  useEffect(() => {
    if (media?.mediaType !== "tv" || !media.tmdbId || !media.episodeNumber
      || !Number.isFinite(segmentDurationRounded) || segmentDurationRounded <= 0) return undefined;
    const controller = new AbortController();
    const params = new URLSearchParams({
      tmdbId: String(media.tmdbId), season: String(media.seasonNumber),
      episode: String(media.episodeNumber), duration: String(segmentDurationRounded),
    });
    void fetch(`/api/playback/segments?${params}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => response.ok ? responseJson(response) : null)
      .then((data) => {
        if (!controller.signal.aborted) {
          setSegments(data?.segments || { intro: null, recap: null, outro: null, preview: null });
          setSegmentSourceIdentity(sourceIdentity);
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, [media?.mediaType, media?.tmdbId, media?.seasonNumber, media?.episodeNumber,
    segmentDurationRounded, sourceIdentity]);

  const currentPreferredAudioLanguage = useEffectEvent(() => preferredAudioLanguage);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    queueMicrotask(() => {
      if (cancelled) return;
      setAudioInspection("loading");
      setAudioError("");
      setPlaybackState("inspecting");
    });
    void fetch(playbackUrl, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const payload = await responseJson(response);
        if (!response.ok) throw new Error(payload?.error || "Audio tracks could not be inspected.");
        if (cancelled) return;
        const tracks = Array.isArray(payload?.media?.audioTracks) ? payload.media.audioTracks : [];
        const selected = selectAudioTrack(tracks, currentPreferredAudioLanguage());
        const capabilities = await detectClientCapabilities(payload.media, selected?.index ?? null, {
          videoElement: videoRef.current,
        });
        if (tracks.length > 1 && selected && !selected.default) capabilities.direct = "unsupported";
        if (cancelled) return;
        setAudioTracks(tracks);
        setSelectedAudioStreamIndex(selected?.index ?? null);
        setClientCapabilities(capabilities);
        setPlaybackDetails(payload);
        setAudioInspection("ready");
        setPlaybackState("idle");
      })
      .catch((error) => {
        if (cancelled || error.name === "AbortError") return;
        setAudioInspection("failed");
        setAudioError(error.message || "Audio tracks could not be inspected.");
        setPlaybackState("failed");
        setPlaybackError(error.message || "The video could not be inspected for playback.");
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [playbackUrl, sourceIdentity]);

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
    playbackReadyAbortRef.current?.abort(new Error(message || "The video could not be prepared for playback."));
    playbackReadyAbortRef.current = null;
    hlsRef.current?.destroy();
    hlsRef.current = null;
    seekTargetRef.current = null;
    setSeekPreview(null);
    setPlaybackState("failed");
    setPlaybackError(message || "The video could not be prepared for playback.");
  }

  function recordPlaybackFailure(details) {
    const fallback = nextPlaybackFallback(details, {
      failedStrategies: failedStrategiesRef.current,
      failedAudioCodecs: failedAudioCodecsRef.current,
    });
    failedStrategiesRef.current = fallback.failedStrategies;
    failedAudioCodecsRef.current = fallback.failedAudioCodecs;
    return fallback.retry;
  }

  function retryWithCompatibilityFallback(details, message) {
    if (!recordPlaybackFailure(details)) return false;
    setPlaybackHint(`${message} Trying the next compatible playback method…`);
    void preparePlayback(timelineRef.current.position || initialPosition,
      selectedAudioStreamIndex, playWhenReadyRef.current);
    return true;
  }

  async function reportPlayerFailure(message) {
    const status = await refreshStatus();
    if (status?.state !== "failed") failPlayback(message);
  }

  function startPreparedVideo(video, poll = true) {
    setPlaybackState("ready");
    if (poll) startPolling();
    if (!playWhenReadyRef.current) {
      setPlaybackHint("");
      return;
    }
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

  function attachHls(
    manifestUrl,
    generation = playbackGenerationRef.current,
    details = playbackDetails,
    capabilities = clientCapabilities,
  ) {
    const video = videoRef.current;
    if (!video) return;

    recoveryRef.current = { media: false, network: false };
    const preferNative = capabilities?.transport?.nativeHls === "supported"
      && Boolean(details?.playbackPlan?.output?.hdrFormat
        || details?.playbackPlan?.output?.videoCodec === "hevc");
    if (!preferNative && Hls.isSupported()) {
      const hls = new Hls({
        // Keep high-bitrate fMP4 demuxing off the UI thread. This is
        // particularly important for HDR and Dolby Vision playback on TVs.
        enableWorker: true,
        startFragPrefetch: true,
        startPosition: Math.max(0, Number(details?.startOffsetSeconds) || 0),
      });
      hlsRef.current = hls;
      hls.on(Hls.Events.MEDIA_ATTACHED, () => {
        if (generation === playbackGenerationRef.current) hls.loadSource(manifestUrl);
      });
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (generation === playbackGenerationRef.current) startPreparedVideo(video);
      });
      hls.on(Hls.Events.FRAG_BUFFERED, () => {
        if (generation === playbackGenerationRef.current) video.dispatchEvent(new Event("torplayhlsbuffered"));
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (generation !== playbackGenerationRef.current) return;
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
        const message = `HLS playback failed: ${data.details || data.error?.message || "unknown player error"}.`;
        if (!retryWithCompatibilityFallback(details, message)) void reportPlayerFailure(message);
      });
      hls.attachMedia(video);
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.addEventListener("canplay", () => {
        if (generation === playbackGenerationRef.current) {
          const offset = Math.max(0, Number(details?.startOffsetSeconds) || 0);
          if (offset > 0 && offset < video.duration) video.currentTime = offset;
          startPreparedVideo(video);
        }
      }, { once: true });
      video.src = manifestUrl;
      video.load();
    } else {
      failPlayback("This browser does not support HLS playback.");
    }
  }

  function attachDirect(sourceUrl, startTime, generation = playbackGenerationRef.current) {
    const video = videoRef.current;
    if (!video) return;
    video.addEventListener("loadedmetadata", () => {
      if (generation !== playbackGenerationRef.current) return;
      if (startTime > 0 && startTime < video.duration) video.currentTime = startTime;
    }, { once: true });
    video.addEventListener("canplay", () => {
      if (generation === playbackGenerationRef.current) startPreparedVideo(video, false);
    }, { once: true });
    video.src = sourceUrl;
    video.load();
  }

  async function preparePlayback(
    startTime = 0,
    audioStreamIndex = selectedAudioStreamIndex,
    playWhenReady = true,
    waitUntilReady = false,
  ) {
    const generation = ++playbackGenerationRef.current;
    abortRef.current?.abort();
    playbackReadyAbortRef.current?.abort(new DOMException("Playback preparation was replaced.", "AbortError"));
    const readyController = new AbortController();
    playbackReadyAbortRef.current = readyController;
    hlsRef.current?.destroy();
    hlsRef.current = null;
    const video = videoRef.current;
    video?.pause();
    video?.removeAttribute("src");
    video?.load();
    setPlaybackError("");
    setPlaybackHint("");
    setPlaybackState("preparing");
    playWhenReadyRef.current = playWhenReady;
    abortRef.current = new AbortController();
    try {
      let requestCapabilities = clientCapabilities;
      if (playbackDetails?.media) {
        requestCapabilities = await detectClientCapabilities(
          playbackDetails.media,
          audioStreamIndex,
          { videoElement: videoRef.current },
        );
        const requestedTrack = audioTracks.find((track) => track.index === audioStreamIndex);
        if (audioTracks.length > 1 && requestedTrack && !requestedTrack.default) {
          requestCapabilities.direct = "unsupported";
        }
        setClientCapabilities(requestCapabilities);
      }
      const response = await fetch(playbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startTime,
          audioStreamIndex,
          capabilities: requestCapabilities,
          failedStrategies: failedStrategiesRef.current,
          failedAudioCodecs: failedAudioCodecsRef.current,
        }),
        signal: abortRef.current.signal,
      });
      const payload = await responseJson(response);
      if (generation !== playbackGenerationRef.current) return;
      if (!response.ok) {
        const error = new Error(payload?.error || `Playback preparation failed with HTTP ${response.status}.`);
        error.playbackStrategy = payload?.strategy || null;
        error.playbackPlan = payload?.playbackPlan || null;
        throw error;
      }
      if (!payload?.manifestUrl && !payload?.sourceUrl) {
        throw new Error("The server did not return a playable source.");
      }
      preparedRef.current = true;
      setPlaybackDetails(payload);
      setAudioTracks(payload.media?.audioTracks || []);
      setSelectedAudioStreamIndex(payload.media?.selectedAudioStreamIndex ?? audioStreamIndex ?? null);
      if (payload.delivery === "direct") attachDirect(payload.sourceUrl, startTime, generation);
      else attachHls(payload.manifestUrl, generation, payload, requestCapabilities);
      if (waitUntilReady) await waitForDecodedFrame(video, { signal: readyController.signal });
      if (generation !== playbackGenerationRef.current) return false;
      if (playbackReadyAbortRef.current === readyController) playbackReadyAbortRef.current = null;
      return true;
    } catch (error) {
      if (generation === playbackGenerationRef.current && error.name !== "AbortError") {
        if (recordPlaybackFailure({
          strategy: error.playbackStrategy,
          playbackPlan: error.playbackPlan,
        })) {
          setPlaybackHint(`${error.message} Trying the next compatible playback method…`);
          return preparePlayback(startTime, audioStreamIndex, playWhenReady, waitUntilReady);
        }
        failPlayback(error.message);
      }
      return false;
    }
  }

  const switchCastForCurrentSource = useEffectEvent(() => {
    void remotePlayback.switchCastSource(() => prepareRemoteSource(initialPosition))
      .finally(() => { castTransitionRef.current = false; });
  });

  useEffect(() => {
    if (sourceIdentityRef.current === null) {
      sourceIdentityRef.current = sourceIdentity;
      return;
    }
    if (sourceIdentityRef.current === sourceIdentity) return;
    sourceIdentityRef.current = sourceIdentity;
    castTransitionRef.current = remotePlayback.castState.active;
    playbackGenerationRef.current += 1;
    abortRef.current?.abort();
    playbackReadyAbortRef.current?.abort(new DOMException("Playback source changed.", "AbortError"));
    playbackReadyAbortRef.current = null;
    stopPolling();
    hlsRef.current?.destroy();
    hlsRef.current = null;
    clearTimeout(seekTimerRef.current);
    clearTimeout(tapTimerRef.current);
    clearTimeout(feedbackTimerRef.current);
    seekTargetRef.current = null;
    const video = videoRef.current;
    video?.pause();
    video?.removeAttribute("src");
    video?.load();
    preparedRef.current = false;
    failedStrategiesRef.current = [];
    failedAudioCodecsRef.current = [];
    setClientCapabilities(null);
    initialSeekAppliedRef.current = false;
    resetSentRef.current = false;
    endedRef.current = false;
    nearEndNotifiedRef.current = false;
    earlyEndRecoveryRef.current = false;
    recoveryRef.current = { media: false, network: false };
    timelineRef.current = { position: 0, duration: 0 };
    setCurrentTime(0);
    setDuration(0);
    setBufferedRanges([]);
    setSeekPreview(null);
    setSkipFeedback(null);
    setSegments({ intro: null, recap: null, outro: null, preview: null });
    setSegmentSourceIdentity(null);
    setCountdownRemaining(null);
    autoSkippedRef.current = new Set();
    setPlaybackDetails(null);
    setPlaybackError("");
    setPlaybackHint("");
    setProgressError("");
    setPlaying(false);
    setBuffering(false);
    setPlaybackState("inspecting");
    setAudioInspection("loading");
    setAudioTracks([]);
    setSelectedAudioStreamIndex(null);
    setAudioError("");
    setSubtitleDiscovery((current) => ({ ...current, state: "loading", tracks: [] }));
    setSubtitleCues({});
    setActiveSubtitleId(null);
    setSubtitleError("");
    setMenu(null);
  }, [sourceIdentity, remotePlayback.castState.active]);

  useEffect(() => {
    if (audioInspection === "ready" && castTransitionRef.current
      && remotePlayback.castState.active) switchCastForCurrentSource();
  }, [audioInspection, remotePlayback.castState.active]);

  useEffect(() => {
    if (!suspended) return;
    playbackGenerationRef.current += 1;
    abortRef.current?.abort();
    playbackReadyAbortRef.current?.abort(new DOMException("Playback was suspended.", "AbortError"));
    playbackReadyAbortRef.current = null;
    stopPolling();
    hlsRef.current?.destroy();
    hlsRef.current = null;
    videoRef.current?.pause();
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setBuffering(false);
      setPlaying(false);
      setPlaybackHint("Choose a source to continue watching.");
    });
    return () => { cancelled = true; };
  }, [suspended]);

  useEffect(() => {
    if (suspended) {
      (sourcePickerRef.current?.querySelector(".playerSourcePickerContent button:not(:disabled)")
        || sourcePickerRef.current?.querySelector("button:not(:disabled)"))?.focus({ preventScroll: true });
    }
  }, [suspended]);

  const startAutomatically = useEffectEvent(() => {
    if (audioInspection === "loading") return;
    if (remotePlayback.castState.active) {
      if (castTransitionRef.current) return;
      void remotePlayback.switchCastSource(() => prepareRemoteSource(initialPosition))
        .finally(() => { castTransitionRef.current = false; });
      return;
    }
    if (requiresPreparedPlayback) {
      initialSeekAppliedRef.current = true;
      void preparePlayback(initialPosition);
      return;
    }
    const video = videoRef.current;
    if (!video) return;
    void video.play().catch((error) => {
      if (error.name === "NotAllowedError" || error.name === "AbortError") {
        setPlaybackHint("Playback is ready. Press play to begin.");
      } else {
        setPlaybackError(`The browser could not start playback: ${error.message}`);
      }
    });
  });

  useEffect(() => {
    if (!autoStart || watchTogetherActive) return undefined;
    let cancelled = false;
    queueMicrotask(() => { if (!cancelled) startAutomatically(); });
    return () => { cancelled = true; };
  }, [audioInspection, autoStart, sourceIdentity, watchTogetherActive]);

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

  async function prepareRemoteSource(
    startTime = timelineRef.current.position,
    audioStreamIndex = selectedAudioStreamIndex,
  ) {
    const origin = await getRemoteOrigin();
    let mediaPath = `${baseUrl}/stream`;
    let contentType = file.mimeType;
    let originSeconds = 0;
    let receiverStartTime = Math.max(0, Number(startTime) || 0);
    let sourceDuration = timelineRef.current.duration;
    let mode = "direct";

    {
      const response = await fetch(playbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startTime: receiverStartTime,
          audioStreamIndex,
          capabilities: {
            direct: "unsupported",
            hls: "supported",
            video: { h264: "supported", hevc: "unsupported", hdr: "unsupported", dolbyVision: "unsupported" },
            audio: { aac: "supported", ac3: "unsupported", eac3: "unsupported", truehd: "unsupported", atmos: "unsupported" },
          },
        }),
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
    if (castTransitionRef.current) return;
    if (cast.active) {
      if (!castWasActiveRef.current) {
        video?.pause();
        hlsRef.current?.destroy();
        hlsRef.current = null;
        initialSeekAppliedRef.current = true;
      }
      const nextDuration = cast.duration || timelineRef.current.duration;
      timelineRef.current = { position: cast.position, duration: nextDuration };
      if (!nearEndNotifiedRef.current && shouldOfferNextEpisode(
        cast.position, nextDuration, segmentPlaybackRange(currentSegments.outro),
      )) {
        nearEndNotifiedRef.current = true;
        onNearEnd?.({ position: cast.position, duration: nextDuration });
      }
      if (!endedRef.current && nextDuration > 0 && cast.position >= nextDuration && !cast.playing) {
        endedRef.current = true;
        void saveProgress({ position: nextDuration, duration: nextDuration }).finally(() => onEnded?.());
      }
    } else if (castWasActiveRef.current) {
      if (!requiresPreparedPlayback && video && timelineRef.current.position < video.duration) {
        video.currentTime = timelineRef.current.position;
      } else if (requiresPreparedPlayback) {
        hlsRef.current?.destroy();
        hlsRef.current = null;
        video?.removeAttribute("src");
        video?.load();
      }
    }
    castWasActiveRef.current = cast.active;
  }, [
    requiresPreparedPlayback,
    onEnded,
    onNearEnd,
    remotePlayback.castState,
    saveProgress,
    currentSegments.outro,
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
        } else if (subtitleChoiceRef.current) {
          const choice = subtitleChoiceRef.current;
          const matching = payload.tracks.find((track) => track.language === choice.language
            && track.source === choice.source)
            || payload.tracks.find((track) => track.language === choice.language);
          activeSubtitleRef.current = matching?.id || null;
          setActiveSubtitleId(matching?.id || null);
          if (!matching && payload.state !== "loading") {
            setPlaybackHint(`${choice.language.toUpperCase()} subtitles are unavailable for this episode.`);
          }
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
    playbackReadyAbortRef.current?.abort(new DOMException("Player closed.", "AbortError"));
    stopPolling();
    hlsRef.current?.destroy();
    clearTimeout(hideTimerRef.current);
    clearTimeout(seekTimerRef.current);
    clearTimeout(tapTimerRef.current);
    clearTimeout(feedbackTimerRef.current);
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
    const origin = requiresPreparedPlayback ? (playbackDetails?.originSeconds || 0) : 0;
    const nextPosition = origin + (video.currentTime || 0);
    const pendingSeek = seekTargetRef.current;
    const seekConfirmed = pendingSeek && seekHasArrived(
      nextPosition, pendingSeek.target, playbackState === "preparing",
    );
    if (seekConfirmed) {
      seekTargetRef.current = null;
      setSeekPreview(null);
    }
    const visiblePosition = pendingSeek && !seekConfirmed ? pendingSeek.target : nextPosition;
    setCurrentTime(visiblePosition);
    const reportedDuration = Number(playbackDetails?.duration || playbackDetails?.media?.duration);
    const nextDuration = Number.isFinite(reportedDuration) && reportedDuration > 0
      ? reportedDuration
      : Number.isFinite(video.duration) ? video.duration : 0;
    setDuration(nextDuration);
    timelineRef.current = {
      position: visiblePosition,
      duration: nextDuration,
    };
    if (!pendingSeek && playbackState !== "preparing" && !suspended && !watchTogether?.isGuest
      && !nearEndNotifiedRef.current && shouldOfferNextEpisode(
        nextPosition, nextDuration, segmentPlaybackRange(currentSegments.outro),
      )) {
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
    if (suspended || playbackState === "preparing" || seekTargetRef.current) return;
    const timeline = updateTimeline(video);
    setPlaying(false);
    if (!isPlaybackAtEnd(timeline.position, timeline.duration)) {
      void saveProgress(timeline).finally(() => {
        if (requiresPreparedPlayback && !earlyEndRecoveryRef.current) {
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
      if (!watchTogether?.isGuest) onEnded?.();
    });
  }

  async function togglePlayback() {
    if (suspended || playbackState === "inspecting" || watchTogetherPlaybackLocked) return;
    if (remotePlayback.castState.active) {
      remotePlayback.toggleCastPlayback();
      return;
    }
    const video = videoRef.current;
    if (!video) return;
    if (
      requiresPreparedPlayback
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
      const selected = subtitles.find((subtitle) => subtitle.id === id);
      subtitleChoiceRef.current = selected
        ? { language: selected.language, source: selected.source } : null;
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

  function audioLanguageLabel(track) {
    return track?.language && track.language !== "und"
      ? displayLanguage(track.language)
      : t("Unknown language");
  }

  function audioTrackDetails(track) {
    return [
      track.commentary ? t("Commentary") : null,
      track.audioDescription ? t("Audio description") : null,
      track.title,
      track.channelLayout || (track.channels ? t("{count} channels", { count: track.channels }) : null),
      track.atmos ? "Dolby Atmos" : null,
      track.codec?.toUpperCase(),
    ].filter(Boolean).join(" · ");
  }

  async function switchAudioTrack(streamIndex) {
    const nextTrack = audioTracks.find((track) => track.index === streamIndex);
    if (!nextTrack || streamIndex === selectedAudioStreamIndex) {
      setMenu(null);
      return;
    }
    const previousIndex = selectedAudioStreamIndex;
    const position = timelineRef.current.position || initialPosition;
    const shouldResume = effectivePlaying;
    setSelectedAudioStreamIndex(streamIndex);
    setAudioError("");
    setMenu(null);

    if (!preparedRef.current && !remotePlayback.castState.active) return;
    if (remotePlayback.castState.active) {
      const source = await remotePlayback.switchCastSource(
        () => prepareRemoteSource(position, streamIndex),
      );
      if (!source) setSelectedAudioStreamIndex(previousIndex);
      return;
    }

    const switched = await preparePlayback(position, streamIndex, shouldResume);
    if (switched) return;
    setSelectedAudioStreamIndex(previousIndex);
    setAudioError(t("The selected audio track could not be played. Restoring the previous track."));
    if (previousIndex !== null) await preparePlayback(position, previousIndex, shouldResume);
  }

  async function saveSelectedAudioPreference() {
    if (!profileId || !updateAudioPreferences || !selectedAudioTrack || selectedAudioTrack.language === "und"
      || isSpecialAudioTrack(selectedAudioTrack)) return;
    setSavingAudioPreference(true);
    setAudioError("");
    try {
      await updateAudioPreferences(profileId, { preferredLanguage: selectedAudioTrack.language });
      setPlaybackHint(t("{language} will be preferred for this profile.", {
        language: audioLanguageLabel(selectedAudioTrack),
      }));
    } catch (error) {
      setAudioError(error.message || t("Audio preference could not be saved."));
    } finally {
      setSavingAudioPreference(false);
    }
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

  function requestSeek(target, immediate = false, fromWatchTogether = false) {
    if (!effectiveDuration || suspended || (watchTogetherTransportLocked && !fromWatchTogether)) return;
    const next = clampSeekTarget(target, effectiveDuration);
    if (next === null) return;
    seekTargetRef.current = { target: next };
    setSeekPreview(next);
    timelineRef.current.position = next;
    if (next === 0) void saveProgress({ position: 0, duration: effectiveDuration, reset: true });
    clearTimeout(seekTimerRef.current);
    if (remotePlayback.castState.active) {
      const commitRemoteSeek = async () => {
        setBuffering(true);
        await remotePlayback.seekCast(next, prepareRemoteSource);
        if (seekTargetRef.current?.target === next) {
          seekTargetRef.current = null;
          setSeekPreview(null);
        }
        setBuffering(false);
      };
      seekTimerRef.current = setTimeout(() => void commitRemoteSeek(), immediate ? 0 : 300);
      return;
    }
    const commit = async () => {
      if (watchTogetherActive && watchTogether?.isHost && !fromWatchTogether
        && watchTogether.seekTogether(next)) return;
      setBuffering(true);
      if (!requiresPreparedPlayback) {
        if (videoRef.current) videoRef.current.currentTime = next;
        return;
      }
      await preparePlayback(next);
    };
    seekTimerRef.current = setTimeout(() => void commit(), immediate ? 0 : 300);
  }

  function skipBy(seconds) {
    if (suspended || !effectiveDuration || watchTogetherTransportLocked) return;
    const target = skipTarget(effectiveCurrentTime, seekTargetRef.current?.target, seconds, effectiveDuration);
    if (target === null) return;
    requestSeek(target, true);
    setSkipFeedback({ seconds, target });
    clearTimeout(feedbackTimerRef.current);
    feedbackTimerRef.current = setTimeout(() => setSkipFeedback(null), 1_100);
  }

  function handleVideoPointerUp(event) {
    if (event.pointerType !== "touch") return;
    event.preventDefault();
    suppressTouchClickRef.current = true;
    const bounds = event.currentTarget.getBoundingClientRect();
    const side = event.clientX < bounds.left + bounds.width / 2 ? "left" : "right";
    const now = Date.now();
    const previous = touchTapRef.current;
    if (previous?.side === side && now - previous.time < 330) {
      clearTimeout(tapTimerRef.current);
      touchTapRef.current = null;
      skipBy(side === "left" ? -10 : 10);
      return;
    }
    touchTapRef.current = { side, time: now };
    clearTimeout(tapTimerRef.current);
    tapTimerRef.current = setTimeout(() => {
      touchTapRef.current = null;
      if (controlsVisible) setControlsVisible(false);
      else revealControls(false);
    }, 330);
  }

  async function toggleFullscreen() {
    try {
      const result = await toggleBrowserFullscreen(document, playerRef.current, {
        viewportActive: viewportFullscreen,
        enterViewport: () => {
          setViewportFullscreen(true);
          setHomeScreenHintVisible(needsHomeScreenForImmersivePlayback(
            navigator, window.matchMedia?.("(display-mode: standalone), (display-mode: fullscreen)")?.matches,
          ));
        },
        exitViewport: () => {
          setViewportFullscreen(false);
          setHomeScreenHintVisible(false);
        },
      });
      if (result === "enter") playerRef.current?.focus({ preventScroll: true });
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
    } else if ((key === "arrowleft" || key === "mediarewind") && effectiveDuration) {
      event.preventDefault();
      skipBy(-10);
    } else if ((key === "arrowright" || key === "mediafastforward") && effectiveDuration) {
      event.preventDefault();
      skipBy(10);
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

  const nativeUrl = playbackDetails?.delivery === "direct" ? playbackDetails.sourceUrl : undefined;
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
  const canSeek = effectiveDuration > 0 && !watchTogetherTransportLocked;
  const timelineTime = seekPreview ?? effectiveCurrentTime;
  const playedRatio = effectiveDuration > 0 ? timelineTime / effectiveDuration : 0;
  const skipSegment = activeSkipSegment(timelineTime, currentSegments);
  const showSkipButton = !suspended && showManualSkip(skipSegment, playbackPreferences.autoSkipIntrosRecaps);
  const showEpisodePrompt = !suspended && !watchTogether?.isGuest && Boolean(nextEpisodePrompt)
    && (nextEpisodePrompt.immediate
      || shouldShowUpNext(timelineTime, effectiveDuration, segmentPlaybackRange(currentSegments.outro)));
  const activateEpisodePrompt = useEffectEvent(() => nextEpisodePrompt?.onAction?.());
  const autoSkipSegment = useEffectEvent((segment) => {
    if (autoSkippedRef.current.has(segment.type)) return;
    autoSkippedRef.current.add(segment.type);
    requestSeek(segment.endMs / 1000, true);
  });

  const watchTogetherController = useEffectEvent(() => ({
    getState: () => ({
      position: timelineRef.current.position,
      duration: timelineRef.current.duration,
      playing: Boolean(videoRef.current && !videoRef.current.paused && !videoRef.current.ended),
    }),
    play: async () => {
      const video = videoRef.current;
      if (!video) throw new Error("The local player is unavailable.");
      if (requiresPreparedPlayback && (["idle", "failed"].includes(playbackState) || !hlsRef.current)) {
        const prepared = await preparePlayback(timelineRef.current.position, selectedAudioStreamIndex, true);
        if (!prepared) throw new Error("The local source could not be prepared.");
      }
      await waitForCanPlay(video);
      await playForSync(video);
    },
    pause: () => videoRef.current?.pause(),
    pauseForSync: async () => {
      const video = videoRef.current;
      if (!video) throw new Error("The local player is unavailable.");
      await pauseForSync(video);
    },
    seek: async (target) => {
      const video = videoRef.current;
      if (!video) throw new Error("The local player is unavailable.");
      const next = clampSeekTarget(target, timelineRef.current.duration);
      if (next === null) return;
      timelineRef.current.position = next;
      setSeekPreview(next);
      if (requiresPreparedPlayback) {
        const prepared = await preparePlayback(next, selectedAudioStreamIndex, false, true);
        if (!prepared) throw new Error("The local source could not seek to the host position.");
      } else {
        video.currentTime = next;
        await waitForSynchronizedPosition(video, next);
      }
      seekTargetRef.current = null;
      setSeekPreview(null);
    },
    setRate: (rate) => {
      if (videoRef.current) videoRef.current.playbackRate = rate;
      setPlaybackRate(rate);
    },
    prime: async () => {
      const video = videoRef.current;
      if (!video) throw new Error("The local player is unavailable.");
      const wasMuted = video.muted;
      video.muted = true;
      await video.play();
      video.pause();
      video.muted = wasMuted;
    },
  }));

  useEffect(() => {
    if (!watchTogetherActive || !attachWatchTogetherPlayer) return undefined;
    if (videoRef.current) videoRef.current.playbackRate = 1;
    return attachWatchTogetherPlayer(media, watchTogetherController());
  }, [attachWatchTogetherPlayer, media, sourceIdentity, watchTogetherActive]);

  const prepareWatchTogetherSource = useEffectEvent(() => {
    void preparePlayback(initialPosition, selectedAudioStreamIndex, false);
  });

  useEffect(() => {
    if (!watchTogetherActive || !requiresPreparedPlayback || audioInspection !== "ready"
      || playbackState !== "idle") return;
    queueMicrotask(() => prepareWatchTogetherSource());
  }, [audioInspection, playbackState, requiresPreparedPlayback, sourceIdentity, watchTogetherActive]);

  useEffect(() => {
    if (suspended || !playbackPreferences.autoSkipIntrosRecaps || !automaticSegment(skipSegment)) return;
    autoSkipSegment(skipSegment);
  }, [suspended, playbackPreferences.autoSkipIntrosRecaps, skipSegment, sourceIdentity]);

  useEffect(() => {
    if (!showSkipButton) return undefined;
    const button = skipButtonRef.current;
    const player = playerRef.current;
    button?.focus({ preventScroll: true });
    return () => {
      if (document.activeElement === button) player?.focus({ preventScroll: true });
    };
  }, [showSkipButton, skipSegment?.type, sourceIdentity]);

  useEffect(() => {
    if (!showEpisodePrompt || (!nextEpisodePrompt?.action && !nextEpisodePrompt?.secondaryAction)) return undefined;
    const prompt = episodePromptRef.current;
    const player = playerRef.current;
    prompt?.querySelector("button")?.focus({ preventScroll: true });
    return () => {
      if (prompt?.contains(document.activeElement)) player?.focus({ preventScroll: true });
    };
  }, [showEpisodePrompt, nextEpisodePrompt?.kind, nextEpisodePrompt?.action,
    nextEpisodePrompt?.secondaryAction, sourceIdentity]);

  useEffect(() => {
    if (!showEpisodePrompt || nextEpisodePrompt?.kind !== "ready"
      || !playbackPreferences.autoPlayNextEpisode || !automaticSegment(currentSegments.outro) || !effectivePlaying) {
      queueMicrotask(() => setCountdownRemaining(null));
      return undefined;
    }
    let remaining = 10;
    queueMicrotask(() => setCountdownRemaining(remaining));
    const timer = setInterval(() => {
      remaining -= 1;
      setCountdownRemaining(remaining);
      if (remaining <= 0) {
        clearInterval(timer);
        activateEpisodePrompt();
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [showEpisodePrompt, nextEpisodePrompt?.kind, playbackPreferences.autoPlayNextEpisode,
    currentSegments.outro, effectivePlaying, sourceIdentity]);

  async function updatePlaybackSetting(key) {
    if (!onPlaybackPreferencesChange || savingSetting) return;
    setSavingSetting(true);
    setSettingsError("");
    try {
      await onPlaybackPreferencesChange({ ...playbackPreferences, [key]: !playbackPreferences[key] });
    } catch (error) {
      setSettingsError(error.message || "Playback settings could not be saved.");
    } finally {
      setSavingSetting(false);
    }
  }

  function handleEpisodePromptKeyDown(event) {
    const buttons = Array.from(episodePromptRef.current?.querySelectorAll("button:not(:disabled)") || []);
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key) && buttons.length > 1) {
      event.preventDefault();
      event.stopPropagation();
      const direction = ["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : -1;
      const index = buttons.indexOf(document.activeElement);
      buttons[(index + direction + buttons.length) % buttons.length].focus({ preventScroll: true });
    } else if (["OK", "Select"].includes(event.key) && event.target instanceof HTMLButtonElement) {
      event.preventDefault();
      event.stopPropagation();
      event.target.click();
    }
  }

  const visibleSubtitleCues = remotePlayback.castState.active || playbackState === "preparing" || activeSubtitleId === null
    ? []
    : activeSubtitleCues(subtitleCues[activeSubtitleId], effectiveCurrentTime, subtitleDelay);
  const subtitleGroups = subtitleDiscovery.preferences.enabledLanguages
    .map((language) => ({
      language,
      tracks: subtitles.filter((subtitle) => subtitle.language === language),
    }))
    .filter((group) => group.tracks.length > 0);

  const playbackBadges = playbackMediaBadges(
    playbackDetails?.media,
    playbackDetails?.playbackPlan,
  );

  useEffect(() => {
    if (menu !== "captions") return;
    const items = captionMenuItems();
    const active = items.find((item) => item.getAttribute("aria-checked") === "true");
    focusCaptionMenuItem(active || items[0]);
  }, [activeSubtitleId, menu, subtitles.length]);

  const output = playbackDetails?.playbackPlan?.output;
  const hdrLabel = output?.hdrFormat === "dolby-vision" ? "Dolby Vision"
    : output?.hdrFormat === "hdr10-plus" ? "HDR10+"
      : output?.hdrFormat === "hdr10" ? "HDR10"
        : output?.hdrFormat === "hlg" ? "HLG"
          : output?.hdrFormat === "hdr" ? "HDR" : "";
  const videoAction = playbackDetails?.playbackPlan?.videoAction === "copy" ? "preserved"
    : playbackDetails?.playbackPlan?.videoAction === "use-compatible-base-layer"
      ? "compatible layer" : "converted";
  const audioAction = playbackDetails?.playbackPlan?.audioAction === "copy" ? "preserved" : "converted";
  const conversionLabel = playbackDetails?.strategy
    ? `${playbackDetails.strategy === "direct" ? "Direct play"
      : playbackDetails.strategy === "remux" ? "Remux"
        : playbackDetails.strategy === "selective-transcode" ? "Selective conversion"
          : "Compatibility conversion"} · Video: ${codecLabel(output?.videoCodec || playbackDetails.media.videoCodec)}${hdrLabel ? ` ${hdrLabel}` : ""} (${videoAction})${output?.audioCodec || playbackDetails.media.audioCodec ? ` · Audio: ${codecLabel(output?.audioCodec || playbackDetails.media.audioCodec)} (${audioAction})` : ""}`
    : playbackState === "inspecting"
      ? t("Inspecting audio tracks…")
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
        onPointerMove={(event) => { if (event.pointerType !== "touch") revealControls(); }}
        onPointerDown={(event) => { if (event.pointerType !== "touch") revealControls(); }}
        onFocusCapture={() => revealControls()}
      >
        <video
          ref={videoRef}
          playsInline
          x-webkit-airplay="allow"
          preload={!requiresPreparedPlayback ? "auto" : "none"}
          src={nativeUrl}
          onPointerUp={handleVideoPointerUp}
          onClick={(event) => {
            if (event.nativeEvent.pointerType === "touch" || suppressTouchClickRef.current) {
              suppressTouchClickRef.current = false;
              return;
            }
            void togglePlayback();
          }}
          onLoadStart={() => setPlaybackError("")}
          onLoadedMetadata={(event) => {
            const video = event.currentTarget;
            video.volume = volume;
            video.muted = muted;
            video.playbackRate = playbackRate;
            updateTimeline(video);
            if (watchTogetherActive) watchTogether.reportPlayer({ duration: Number(video.duration) || 0 });
            if (
              !requiresPreparedPlayback
              && !initialSeekAppliedRef.current
              && initialPosition > 0
              && initialPosition < video.duration
            ) {
              initialSeekAppliedRef.current = true;
              video.currentTime = initialPosition;
            }
          }}
          onDurationChange={(event) => {
            const timeline = updateTimeline(event.currentTarget);
            if (watchTogetherActive) watchTogether.reportPlayer({ duration: timeline.duration });
          }}
          onTimeUpdate={(event) => updateTimeline(event.currentTarget)}
          onProgress={(event) => updateTimeline(event.currentTarget)}
          onPlay={() => {
            setPlaying(true);
            revealControls(true);
            if (watchTogetherActive) queueMicrotask(() => watchTogether.broadcastPlayback(true));
          }}
          onPause={() => {
            setPlaying(false);
            revealControls(false);
            if (!endedRef.current) void saveProgress();
            if (watchTogetherActive) queueMicrotask(() => watchTogether.broadcastPlayback(true));
          }}
          onPlaying={() => {
            setBuffering(false);
            setPlaybackHint("");
            if (watchTogetherActive) watchTogether.reportPlayer({ canPlay: true, buffering: false,
              duration: timelineRef.current.duration });
          }}
          onWaiting={() => {
            setBuffering(true);
            if (watchTogetherActive) watchTogether.reportPlayer({ buffering: true });
          }}
          onCanPlay={() => {
            setBuffering(false);
            if (watchTogetherActive) watchTogether.reportPlayer({ canPlay: true, buffering: false,
              duration: timelineRef.current.duration || Number(videoRef.current?.duration) || 0 });
          }}
          onSeeked={() => {
            void saveProgress();
            if (watchTogetherActive) queueMicrotask(() => watchTogether.broadcastPlayback(true));
          }}
          onEnded={(event) => handlePlaybackEnded(event.currentTarget)}
          onVolumeChange={(event) => {
            setVolume(event.currentTarget.volume);
            setMuted(event.currentTarget.muted);
          }}
          onError={() => {
            if (playbackState === "preparing" || suspended) return;
            if (playbackDetails?.delivery === "direct") {
              const message = mediaErrorMessage(videoRef.current?.error);
              if (!retryWithCompatibilityFallback(playbackDetails, message)) {
                setPlaybackError("The browser could not play this video. Try another source.");
              }
              return;
            }
            if (requiresPreparedPlayback) {
              const mediaError = videoRef.current?.error;
              const hls = hlsRef.current;
              if (mediaError?.code === 3 && hls && !recoveryRef.current.media) {
                recoveryRef.current.media = true;
                hls.recoverMediaError();
              } else {
                void reportPlayerFailure(mediaErrorMessage(mediaError));
              }
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

        {skipFeedback ? <div className={`playerSkipFeedback ${skipFeedback.seconds < 0 ? "backward" : "forward"}`}
          role="status" aria-live="polite">
          <strong>{skipFeedback.seconds > 0 ? "+" : "−"}10s</strong>
          <span>{formatTime(skipFeedback.target)}</span>
        </div> : null}

        {suspended && sourcePicker ? <div className="playerSourcePicker"
          ref={sourcePickerRef} role="dialog" aria-label="Choose a source for the episode">
          {isFullscreen ? <button className="playerSourcePickerExit" type="button"
            onClick={() => void toggleFullscreen()}>Exit fullscreen</button> : null}
          {sourcePicker}
        </div> : null}
        {viewportFullscreen && homeScreenHintVisible && !suspended ? <div className="playerHomeScreenHint" role="status">
          <span>To hide Safari bars, tap Share → Add to Home Screen, then open TorPlay from its icon.</span>
          <button type="button" onClick={() => setHomeScreenHintVisible(false)} aria-label="Dismiss fullscreen tip">Got it</button>
        </div> : null}
        {showSkipButton ? <button className="playerSegmentSkip" ref={skipButtonRef} type="button"
          onClick={() => requestSeek(skipSegment.endMs / 1000, true)}>
          Skip {skipSegment.type === "recap" ? "Recap" : "Intro"}
        </button> : null}
        {showEpisodePrompt ? <div className="playerEpisodePrompt" ref={episodePromptRef}
          role={nextEpisodePrompt.action || nextEpisodePrompt.secondaryAction ? "dialog" : "status"}
          aria-label="Next episode"
          onKeyDown={handleEpisodePromptKeyDown}>
          {nextEpisodePrompt.title ? <strong>{nextEpisodePrompt.title}</strong> : null}
          <span>{nextEpisodePrompt.text}</span>
          {countdownRemaining !== null && nextEpisodePrompt.kind === "ready" && automaticSegment(currentSegments.outro)
            ? <small>Playing in {countdownRemaining} seconds</small> : null}
          {nextEpisodePrompt.kind === "ready" && playbackPreferences.autoPlayNextEpisode
            && !automaticSegment(currentSegments.outro)
            ? <small>Will play when this episode ends</small> : null}
          {nextEpisodePrompt.action || nextEpisodePrompt.secondaryAction ? <div className="playerEpisodePromptActions">
            {nextEpisodePrompt.action ? <button type="button" onClick={nextEpisodePrompt.onAction}>
              {nextEpisodePrompt.action}</button> : null}
            {nextEpisodePrompt.secondaryAction ? <button className="playerEpisodePromptSecondary" type="button"
              onClick={nextEpisodePrompt.onSecondaryAction}>{nextEpisodePrompt.secondaryAction}</button> : null}
          </div> : null}
        </div> : null}

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
              : remotePlayback.airPlayActive ? "Playing with AirPlay" : !requiresPreparedPlayback ? "Native" : "HLS"}
          </span>
        </div>
        {playbackBadges.length ? <div className="playerMediaBadges mediaCapabilityBadges" aria-label="Playback media formats">
          {playbackBadges.map((badge) => <span
            className={badge.playbackStatus === "active" ? "active" : "inactive"}
            key={badge.id}
            aria-label={badge.statusLabel}
            title={badge.statusLabel}
          >{badge.label}</span>)}
        </div> : null}

        <div className="playerCenter">
          {playbackState === "inspecting" || playbackState === "preparing" || effectiveBuffering ? (
            <div className="playerSpinner" role="status" aria-label="Buffering" />
          ) : null}
              {!suspended && !["inspecting", "preparing"].includes(playbackState)
            && !effectiveBuffering && !effectivePlaying ? (
            <button className="centerPlayButton" type="button" disabled={watchTogetherPlaybackLocked}
              onClick={() => void togglePlayback()}>
              <Icon name="play" />
              <span className="srOnly">
                {requiresPreparedPlayback && ["idle", "failed"].includes(playbackState)
                  ? playbackState === "failed" ? "Retry playback" : "Prepare and play"
                  : watchTogether?.isGuest ? "Waiting for host" : !watchTogether?.allReady && watchTogetherActive
                    ? "Waiting for everyone" : "Play"}
              </span>
            </button>
          ) : null}
          {requiresPreparedPlayback && ["idle", "failed"].includes(playbackState) ? (
            <span className="prepareLabel">
              {playbackState === "failed" ? "Retry playback" : "Prepare & play"}
            </span>
          ) : null}
        </div>

        <div className="playerBottomBar">
          {menu === "audio" ? (
            <div className="playerMenu captionMenu audioMenu" id="audio-menu" role="menu" aria-label={t("Audio tracks")}>
              <div className="captionMenuHeader"><span>{t("Audio")}</span></div>
              <div className="captionTrackList">
                {audioTracks.map((track) => (
                  <button
                    className={selectedAudioStreamIndex === track.index ? "active" : ""}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selectedAudioStreamIndex === track.index}
                    key={track.index}
                    onClick={() => void switchAudioTrack(track.index)}
                  >
                    <span>{selectedAudioStreamIndex === track.index ? "✓ " : ""}{audioLanguageLabel(track)}</span>
                    <small>{audioTrackDetails(track) || t("Audio track {number}", { number: track.index })}</small>
                  </button>
                ))}
              </div>
              {profileId && selectedAudioTrack && selectedAudioTrack.language !== "und"
                && !isSpecialAudioTrack(selectedAudioTrack) ? (
                  <div className="captionMenuFooter">
                    <button type="button" disabled={savingAudioPreference
                      || preferredAudioLanguage === selectedAudioTrack.language}
                    onClick={() => void saveSelectedAudioPreference()}>
                      {preferredAudioLanguage === selectedAudioTrack.language
                        ? t("Preferred for this profile")
                        : t("Always prefer {language}", { language: audioLanguageLabel(selectedAudioTrack) })}
                    </button>
                  </div>
                ) : null}
            </div>
          ) : null}
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
                  disabled={watchTogetherActive}
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
              {media?.mediaType === "tv" ? <div className="playerPlaybackPreferences">
                <span>Episode playback</span>
                <button type="button" role="menuitemcheckbox"
                  aria-checked={playbackPreferences.autoSkipIntrosRecaps}
                  disabled={savingSetting || !onPlaybackPreferencesChange}
                  onClick={() => void updatePlaybackSetting("autoSkipIntrosRecaps")}>
                  Automatically skip intros and recaps · {playbackPreferences.autoSkipIntrosRecaps ? "On" : "Off"}
                </button>
                <button type="button" role="menuitemcheckbox"
                  aria-checked={playbackPreferences.autoPlayNextEpisode}
                  disabled={savingSetting || !onPlaybackPreferencesChange}
                  onClick={() => void updatePlaybackSetting("autoPlayNextEpisode")}>
                  Automatically play next episode · {playbackPreferences.autoPlayNextEpisode ? "On" : "Off"}
                </button>
                {settingsError ? <small role="alert">{settingsError}</small> : null}
              </div> : null}
            </div>
          ) : null}
          {menu === "together" && watchTogetherActive ? (
            <div className="playerMenu watchTogetherPlayerMenu" aria-label="Watch Together">
              <span>Room {watchTogether.room.code}</span>
              <div className="watchTogetherPlayerRoster">
                {watchTogether.participants.map((participant) => (
                  <div key={participant.id}>
                    <strong>{participant.name}{participant.role === "host" ? " · Host" : ""}</strong>
                    <small>{participant.channel === "reconnecting" ? "Reconnecting…"
                      : participant.channel === "failed" ? "Connection failed"
                      : participant.syncFailed ? "Sync failed" : participant.syncing ? "Seeking…"
                      : participant.ready ? participant.buffering ? "Buffering" : "Ready"
                      : participant.compatible === false ? "Choose another source" : "Not ready"}</small>
                  </div>
                ))}
              </div>
              {watchTogether.localPlayback.canPlay && !watchTogether.localPlayback.ready ? (
                <button type="button" onClick={() => void watchTogether.markReady()}>I&apos;m ready</button>
              ) : null}
              {watchTogether.localPlayback.syncFailed ? (
                <button type="button" onClick={() => void watchTogether.retrySeekSync()}>Retry sync</button>
              ) : null}
              <small className="remotePlaybackNote">{watchTogether.isHost
                ? watchTogether.seekSyncing ? "Waiting for everyone to reach the shared position."
                  : watchTogether.allReady ? "Everyone is ready. You control playback." : "Waiting for everyone to become ready."
                : "The host controls play, pause, seeking, and episodes."}</small>
              <button className="remoteStopButton" type="button" onClick={watchTogether.leaveRoom}>Leave room</button>
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
                      disabled={requiresPreparedPlayback && playbackState !== "ready"}
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
              disabled={!canSeek || suspended}
              aria-label="Seek"
              onChange={(event) => requestSeek(event.target.value)}
            />
          </div>

          <div className="playerControls">
            <div className="controlGroup">
              {onPreviousEpisode ? <button type="button" aria-label="Previous episode"
                title="Previous episode" disabled={!hasPreviousEpisode || suspended || watchTogetherPlaybackLocked}
                onClick={onPreviousEpisode}><Icon name="previous" /></button> : null}
              <button type="button" aria-label={effectivePlaying ? "Pause" : "Play"}
                disabled={watchTogetherPlaybackLocked} onClick={() => void togglePlayback()}>
                <Icon name={effectivePlaying ? "pause" : "play"} />
              </button>
              {onNextEpisode ? <button type="button" aria-label="Next episode"
                title="Next episode" disabled={!hasNextEpisode || suspended || watchTogetherPlaybackLocked}
                onClick={onNextEpisode}><Icon name="next" /></button> : null}
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
              {audioTracks.length > 1 ? (
                <button
                  className={menu === "audio" ? "active" : ""}
                  ref={audioButtonRef}
                  type="button"
                  aria-label={t("Audio tracks")}
                  aria-expanded={menu === "audio"}
                  aria-controls="audio-menu"
                  onClick={() => {
                    clearTimeout(hideTimerRef.current);
                    setControlsVisible(true);
                    setMenu(menu === "audio" ? null : "audio");
                  }}
                >
                  <span className="ccIcon">A</span>
                </button>
              ) : null}
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
              {watchTogetherActive ? (
                <button className={menu === "together" ? "active" : ""} type="button"
                  aria-label="Watch Together" aria-expanded={menu === "together"}
                  onClick={() => {
                    clearTimeout(hideTimerRef.current);
                    setControlsVisible(true);
                    setMenu(menu === "together" ? null : "together");
                  }}><Icon name="together" /></button>
              ) : null}
              {!watchTogetherActive && (remotePlayback.castAvailable || remotePlayback.airPlayAvailable || remotePlayback.castState.active) ? (
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

      {requiresPreparedPlayback ? <div className="conversionNotice">{conversionLabel}</div> : null}
      {subtitleError ? <div className="notice error" role="alert">{subtitleError}</div> : null}
      {audioError ? <div className="notice error" role="alert">{audioError}</div> : null}
      {remotePlayback.error ? <div className="notice error" role="alert">Remote playback: {remotePlayback.error}</div> : null}
      {playbackError ? <div className="notice error" role="alert">{playbackError}</div> : null}
      {playbackHint ? <div className="notice">{playbackHint}</div> : null}
      {progressError ? <div className="notice">Watch progress unavailable: {progressError}</div> : null}
    </div>
  );
}
