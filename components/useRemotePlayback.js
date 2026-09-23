"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  GOOGLE_CAST_SDK_URL,
  castTimeline,
  createCastLoadRequest,
} from "../lib/remote-playback/cast.js";
import { setRemotePlaybackSessionActive } from "../lib/remote-playback/client-state.js";

let castSdkPromise = null;

function errorMessage(error, fallback) {
  if (typeof error === "string") return error;
  return error?.description || error?.message || fallback;
}

function loadGoogleCastSdk(windowImpl = window, documentImpl = document) {
  if (windowImpl.cast?.framework && windowImpl.chrome?.cast?.media) return Promise.resolve(true);
  if (castSdkPromise) return castSdkPromise;
  castSdkPromise = new Promise((resolve) => {
    const previous = windowImpl.__onGCastApiAvailable;
    windowImpl.__onGCastApiAvailable = (available, detail) => {
      previous?.(available, detail);
      resolve(Boolean(available && windowImpl.cast?.framework && windowImpl.chrome?.cast?.media));
    };
    const existing = documentImpl.querySelector(`script[src="${GOOGLE_CAST_SDK_URL}"]`);
    if (existing) {
      existing.addEventListener("error", () => resolve(false), { once: true });
      return;
    }
    const script = documentImpl.createElement("script");
    script.src = GOOGLE_CAST_SDK_URL;
    script.async = true;
    script.addEventListener("error", () => resolve(false), { once: true });
    documentImpl.head.append(script);
  });
  return castSdkPromise;
}

const EMPTY_CAST_STATE = {
  active: false,
  deviceName: "",
  duration: 0,
  muted: false,
  playing: false,
  position: 0,
  volume: 1,
};

export function useRemotePlayback(videoRef) {
  const castContextRef = useRef(null);
  const castPlayerRef = useRef(null);
  const castControllerRef = useRef(null);
  const castSourceRef = useRef(null);
  const [castAvailable, setCastAvailable] = useState(false);
  const [castBusy, setCastBusy] = useState(false);
  const [castState, setCastState] = useState(EMPTY_CAST_STATE);
  const [airPlayAvailable, setAirPlayAvailable] = useState(false);
  const [airPlayActive, setAirPlayActive] = useState(false);
  const [remoteAllowed, setRemoteAllowed] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/playback/remote", { cache: "no-store" })
      .then((response) => { if (!cancelled) setRemoteAllowed(response.status !== 409); })
      .catch(() => { if (!cancelled) setRemoteAllowed(true); });
    return () => { cancelled = true; };
  }, []);

  const refreshCastState = useCallback(() => {
    const player = castPlayerRef.current;
    const source = castSourceRef.current;
    const active = Boolean(player?.isConnected && source);
    if (!active) {
      if (source?.sessionId) setRemotePlaybackSessionActive(source.sessionId, false);
      castSourceRef.current = null;
      setCastState(EMPTY_CAST_STATE);
      return;
    }
    const timeline = castTimeline(source, player);
    const session = castContextRef.current?.getCurrentSession?.();
    setCastState({
      active: true,
      deviceName: session?.getCastDevice?.()?.friendlyName || "Cast device",
      duration: timeline.duration,
      muted: Boolean(player.isMuted),
      playing: !player.isPaused,
      position: timeline.position,
      volume: Number.isFinite(player.volumeLevel) ? player.volumeLevel : 1,
    });
  }, []);

  useEffect(() => {
    if (remoteAllowed !== true) return undefined;
    let cancelled = false;
    let player = null;
    let controller = null;
    let eventType = null;
    void loadGoogleCastSdk().then((available) => {
      if (!available || cancelled) return;
      const framework = window.cast.framework;
      const castApi = window.chrome.cast;
      const context = framework.CastContext.getInstance();
      context.setOptions({
        receiverApplicationId: castApi.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
        autoJoinPolicy: castApi.AutoJoinPolicy.ORIGIN_SCOPED,
      });
      player = new framework.RemotePlayer();
      controller = new framework.RemotePlayerController(player);
      eventType = framework.RemotePlayerEventType.ANY_CHANGE;
      controller.addEventListener(eventType, refreshCastState);
      castContextRef.current = context;
      castPlayerRef.current = player;
      castControllerRef.current = controller;
      setCastAvailable(true);
      refreshCastState();
    });
    return () => {
      cancelled = true;
      if (controller && eventType) controller.removeEventListener(eventType, refreshCastState);
      castContextRef.current = null;
      castPlayerRef.current = null;
      castControllerRef.current = null;
    };
  }, [refreshCastState, remoteAllowed]);

  useEffect(() => {
    if (remoteAllowed !== true) return undefined;
    const video = videoRef.current;
    if (!video) return undefined;
    const supported = typeof video.webkitShowPlaybackTargetPicker === "function";
    setAirPlayAvailable(supported);
    if (!supported) return undefined;
    const updateAvailability = (event) => setAirPlayAvailable(event.availability === "available");
    const updateConnection = () => setAirPlayActive(Boolean(video.webkitCurrentPlaybackTargetIsWireless));
    video.addEventListener("webkitplaybacktargetavailabilitychanged", updateAvailability);
    video.addEventListener("webkitcurrentplaybacktargetiswirelesschanged", updateConnection);
    updateConnection();
    return () => {
      video.removeEventListener("webkitplaybacktargetavailabilitychanged", updateAvailability);
      video.removeEventListener("webkitcurrentplaybacktargetiswirelesschanged", updateConnection);
    };
  }, [videoRef, remoteAllowed]);

  const loadCastSource = useCallback(async (sourceFactory, { requestSession = false } = {}) => {
    const context = castContextRef.current;
    if (!context || !window.chrome?.cast?.media) throw new Error("Google Cast is unavailable in this browser.");
    if (requestSession && !context.getCurrentSession()) await context.requestSession();
    const session = context.getCurrentSession();
    if (!session) throw new Error("No Cast device was selected.");
    const source = await sourceFactory();
    const previous = castSourceRef.current;
    if (previous?.sessionId && previous.sessionId !== source.sessionId) {
      setRemotePlaybackSessionActive(previous.sessionId, false);
    }
    await session.loadMedia(createCastLoadRequest(window.chrome.cast, source));
    castSourceRef.current = source;
    setRemotePlaybackSessionActive(source.sessionId, true);
    refreshCastState();
    return source;
  }, [refreshCastState]);

  const startCast = useCallback(async (sourceFactory) => {
    setCastBusy(true);
    setError("");
    try {
      return await loadCastSource(sourceFactory, { requestSession: true });
    } catch (castError) {
      const errorCode = typeof castError === "string" ? castError : castError?.code;
      const cancelled = errorCode === window.chrome?.cast?.ErrorCode?.CANCEL;
      if (!cancelled) setError(errorMessage(castError, "Casting could not be started."));
      return null;
    } finally {
      setCastBusy(false);
    }
  }, [loadCastSource]);

  const stopCast = useCallback(() => {
    const source = castSourceRef.current;
    castContextRef.current?.endCurrentSession?.(true);
    if (source?.sessionId) setRemotePlaybackSessionActive(source.sessionId, false);
    castSourceRef.current = null;
    setCastState(EMPTY_CAST_STATE);
  }, []);

  const toggleCastPlayback = useCallback(() => {
    castControllerRef.current?.playOrPause();
  }, []);

  const seekCast = useCallback(async (target, sourceFactory) => {
    const source = castSourceRef.current;
    const player = castPlayerRef.current;
    const controller = castControllerRef.current;
    if (!source || !player || !controller) return;
    if (source.mode === "hls") {
      setCastBusy(true);
      setError("");
      try {
        await loadCastSource(() => sourceFactory(target));
      } catch (seekError) {
        setError(errorMessage(seekError, "The Cast device could not seek to that position."));
      } finally {
        setCastBusy(false);
      }
      return;
    }
    player.currentTime = Math.max(0, Number(target) || 0);
    controller.seek();
  }, [loadCastSource]);

  const setCastVolume = useCallback((volume) => {
    const player = castPlayerRef.current;
    if (!player) return;
    player.volumeLevel = Math.min(1, Math.max(0, Number(volume) || 0));
    castControllerRef.current?.setVolumeLevel();
  }, []);

  const toggleCastMute = useCallback(() => {
    castControllerRef.current?.muteOrUnmute();
  }, []);

  const showAirPlayPicker = useCallback(() => {
    setError("");
    try {
      videoRef.current?.webkitShowPlaybackTargetPicker?.();
    } catch (airPlayError) {
      setError(errorMessage(airPlayError, "AirPlay is unavailable."));
    }
  }, [videoRef]);

  return {
    airPlayActive,
    airPlayAvailable,
    castAvailable,
    castBusy,
    castState,
    error,
    seekCast,
    setCastVolume,
    showAirPlayPicker,
    startCast,
    stopCast,
    toggleCastMute,
    toggleCastPlayback,
  };
}
