"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  WATCH_TOGETHER_PROTOCOL_VERSION,
  mediaIdentityHref,
  normalizeMediaIdentity,
  normalizeRoomCode,
  sameMediaIdentity,
  validatePublicRoomPayload,
} from "../lib/watch-together/protocol.js";
import {
  WATCH_TOGETHER_SNAPSHOT_INTERVAL_MS,
  durationsCompatible,
  estimateClockOffset,
  guestCorrection,
  projectedHostPosition,
} from "../lib/watch-together/sync.js";
import { useOptionalProfile } from "./ProfileProvider.js";

const STORAGE_KEY = "torplay:watch-together:v1";
const WatchTogetherContext = createContext(null);

function readJson(response) {
  return response.json().then((data) => {
    if (!response.ok) throw new Error(data?.error || "Watch Together configuration could not be loaded.");
    return data;
  });
}

function storedSession() {
  try { return JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) || "null"); }
  catch { return null; }
}

function saveSession(value) {
  try {
    if (value) window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    else window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {}
}

function closePeer(peer) {
  if (peer) peer.closing = true;
  clearTimeout(peer?.disconnectTimer);
  clearTimeout(peer?.retryTimer);
  try { peer.channel?.close(); } catch {}
  try { peer.pc?.close(); } catch {}
}

export function WatchTogetherProvider({ children }) {
  const router = useRouter();
  const profile = useOptionalProfile();
  const [config, setConfig] = useState({ loading: true, enabled: false, signalUrl: null, stunUrls: [] });
  const [room, setRoom] = useState(null);
  const [serverRoster, setServerRoster] = useState([]);
  const [peerRoster, setPeerRoster] = useState({});
  const [pageMedia, setPageMedia] = useState(null);
  const [connectionState, setConnectionState] = useState("idle");
  const [error, setError] = useState("");
  const [localPlayback, setLocalPlayback] = useState({
    attached: false, canPlay: false, ready: false, buffering: false, duration: 0, compatible: true,
    syncing: false, syncFailed: false,
  });
  const socketRef = useRef(null);
  const roomRef = useRef(null);
  const configRef = useRef(config);
  const peersRef = useRef(new Map());
  const playerRef = useRef(null);
  const localPlaybackRef = useRef(localPlayback);
  const allReadyRef = useRef(false);
  const pendingIceRef = useRef(new Map());
  const reconnectRef = useRef({ timer: null, attempts: 0, intentional: false });
  const playbackSequenceRef = useRef(0);
  const guestSequenceRef = useRef(0);
  const clockOffsetRef = useRef(0);
  const pingRef = useRef(new Map());
  const pendingOpenRef = useRef(null);
  const openSocketRef = useRef(null);
  const resumeAfterMediaChangeRef = useRef(false);
  const seekSequenceRef = useRef(0);
  const activeSeekRef = useRef(null);
  const guestSeekRef = useRef(null);
  const pendingGuestPlaybackRef = useRef(null);
  const guestPlaybackRunningRef = useRef(false);
  const createHostPeerRef = useRef(null);
  const peerRecoveryAttemptsRef = useRef(new Map());
  const pageMediaOwnerRef = useRef(null);

  useEffect(() => { roomRef.current = room; }, [room]);
  useEffect(() => { configRef.current = config; }, [config]);
  useEffect(() => { localPlaybackRef.current = localPlayback; }, [localPlayback]);

  const registerPageMedia = useCallback((media) => {
    const owner = {};
    pageMediaOwnerRef.current = owner;
    setPageMedia(media || null);
    return () => {
      if (pageMediaOwnerRef.current !== owner) return;
      pageMediaOwnerRef.current = null;
      setPageMedia(null);
    };
  }, []);

  const updatePeerState = useCallback((id, patch) => {
    setPeerRoster((current) => ({
      ...current,
      [id]: { ready: false, buffering: false, compatible: true, duration: 0, channel: "connecting",
        syncing: false, syncFailed: false, ...current[id], ...patch },
    }));
  }, []);

  const mergedParticipants = useMemo(() => serverRoster.map((participant) => {
    const local = participant.id === room?.participantId;
    const state = local ? localPlayback : peerRoster[participant.id] || {};
    return {
      ...participant,
      ready: Boolean(state.ready),
      buffering: Boolean(state.buffering),
      syncing: Boolean(state.syncing),
      syncFailed: Boolean(state.syncFailed),
      compatible: state.compatible !== false,
      duration: Number(state.duration) || 0,
      channel: local ? "connected" : state.channel || (participant.connected ? "connecting" : "disconnected"),
    };
  }), [localPlayback, peerRoster, room?.participantId, serverRoster]);

  const allReady = Boolean(room) && mergedParticipants.length > 0
    && mergedParticipants.filter((participant) => participant.connected)
      .every((participant) => participant.ready && participant.compatible && participant.channel === "connected");
  const seekSyncing = mergedParticipants.some((participant) => participant.syncing || participant.syncFailed);
  useEffect(() => { allReadyRef.current = allReady; }, [allReady]);

  const sendSignal = useCallback((value) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ protocol: WATCH_TOGETHER_PROTOCOL_VERSION, ...value }));
  }, []);

  const sendChannel = useCallback((channel, value) => {
    if (channel?.readyState !== "open") return false;
    validatePublicRoomPayload(value);
    channel.send(JSON.stringify(value));
    return true;
  }, []);

  const broadcastChannel = useCallback((value) => {
    for (const peer of peersRef.current.values()) sendChannel(peer.channel, value);
  }, [sendChannel]);

  const publishRoster = useCallback(() => {
    const current = roomRef.current;
    if (current?.role !== "host") return;
    const local = localPlayback;
    const participants = serverRoster.map((participant) => {
      const state = participant.id === current.participantId ? local : peerRoster[participant.id] || {};
      return {
        id: participant.id,
        ready: Boolean(state.ready),
        buffering: Boolean(state.buffering),
        syncing: Boolean(state.syncing),
        syncFailed: Boolean(state.syncFailed),
        compatible: state.compatible !== false,
        duration: Number(state.duration) || 0,
      };
    });
    broadcastChannel({ type: "roster", participants });
  }, [broadcastChannel, localPlayback, peerRoster, serverRoster]);

  useEffect(() => publishRoster(), [publishRoster]);

  const playbackSnapshot = useCallback((explicit = false) => {
    const current = roomRef.current;
    const player = playerRef.current;
    if (current?.role !== "host" || !player || !allReadyRef.current || activeSeekRef.current) return;
    const state = player.getState();
    if (explicit && state.playing) setError("");
    playbackSequenceRef.current += 1;
    broadcastChannel({
      type: "playback",
      sequence: playbackSequenceRef.current,
      position: Math.max(0, Number(state.position) || 0),
      playing: Boolean(state.playing),
      sentAt: Date.now(),
      explicit: Boolean(explicit),
    });
  }, [broadcastChannel]);

  const completeSeekIfReady = useCallback(() => {
    const transition = activeSeekRef.current;
    if (!transition?.localReady
      || [...transition.required].some((participantId) => !transition.ready.has(participantId))) return;
    activeSeekRef.current = null;
    setLocalPlayback((value) => {
      const next = { ...value, syncing: false, syncFailed: false };
      localPlaybackRef.current = next;
      return next;
    });
    for (const participantId of transition.required) {
      updatePeerState(participantId, { syncing: false, syncFailed: false });
    }
    const player = playerRef.current;
    if (!player) return;
    void (async () => {
      try {
        if (transition.resumePlaying) await player.play();
        else {
          player.pause();
          playbackSnapshot(true);
        }
      } catch {
        setError("Your browser needs another click before synchronized playback can continue.");
      }
    })();
  }, [playbackSnapshot, updatePeerState]);

  const performGuestSeek = useCallback(async (transition = guestSeekRef.current) => {
    if (!transition || guestSeekRef.current?.id !== transition.id) return false;
    const player = playerRef.current;
    setLocalPlayback((value) => {
      const next = { ...value, syncing: true, syncFailed: false };
      localPlaybackRef.current = next;
      return next;
    });
    try {
      if (!player) throw new Error("The local player is unavailable.");
      await player.pauseForSync();
      await player.seek(transition.position);
      if (guestSeekRef.current?.id !== transition.id) return false;
      setLocalPlayback((value) => {
        const next = { ...value, syncing: false, syncFailed: false };
        localPlaybackRef.current = next;
        return next;
      });
      const host = [...peersRef.current.values()][0];
      sendChannel(host?.channel, { type: "seek-ready", id: transition.id });
      return true;
    } catch {
      if (guestSeekRef.current?.id !== transition.id) return false;
      setLocalPlayback((value) => {
        const next = { ...value, syncing: false, syncFailed: true };
        localPlaybackRef.current = next;
        return next;
      });
      const host = [...peersRef.current.values()][0];
      sendChannel(host?.channel, { type: "seek-failed", id: transition.id });
      setError("This player could not reach the shared position. Retry synchronization.");
      return false;
    }
  }, [sendChannel]);

  const performHostSeek = useCallback(async (transition = activeSeekRef.current) => {
    if (!transition || activeSeekRef.current?.id !== transition.id) return false;
    setLocalPlayback((value) => {
      const next = { ...value, syncing: true, syncFailed: false };
      localPlaybackRef.current = next;
      return next;
    });
    try {
      const player = playerRef.current;
      if (!player) throw new Error("The local player is unavailable.");
      await player.pauseForSync();
      await player.seek(transition.position);
      if (activeSeekRef.current?.id !== transition.id) return false;
      activeSeekRef.current = { ...activeSeekRef.current, localReady: true };
      setLocalPlayback((value) => {
        const next = { ...value, syncing: false, syncFailed: false };
        localPlaybackRef.current = next;
        return next;
      });
      completeSeekIfReady();
      return true;
    } catch {
      if (activeSeekRef.current?.id !== transition.id) return false;
      setLocalPlayback((value) => {
        const next = { ...value, syncing: false, syncFailed: true };
        localPlaybackRef.current = next;
        return next;
      });
      setError("This player could not reach the shared position. Retry synchronization.");
      return false;
    }
  }, [completeSeekIfReady]);

  const drainGuestPlayback = useCallback(async () => {
    if (guestPlaybackRunningRef.current) return;
    guestPlaybackRunningRef.current = true;
    try {
      while (pendingGuestPlaybackRef.current) {
        const message = pendingGuestPlaybackRef.current;
        pendingGuestPlaybackRef.current = null;
        const player = playerRef.current;
        if (!player || !localPlaybackRef.current.ready) continue;
        const state = player.getState();
        const target = projectedHostPosition(message, Date.now(), clockOffsetRef.current);
        const correction = guestCorrection({
          currentTime: state.position, targetTime: target, playing: message.playing, explicit: message.explicit,
        });
        try {
          if (correction.kind === "seek") await player.seek(correction.target);
          if (Number(message.sequence) < guestSequenceRef.current) continue;
          player.setRate(correction.rate);
          if (message.playing) await player.play();
          else player.pause();
          setError("");
        } catch (playbackError) {
          if (Number(message.sequence) < guestSequenceRef.current) continue;
          if (playbackError?.name === "AbortError" && !message.retried) {
            pendingGuestPlaybackRef.current = { ...message, retried: true };
            continue;
          }
          const blocked = playbackError?.name === "NotAllowedError";
          setError(blocked
            ? "Your browser needs another click before synchronized playback can continue."
            : "This player could not apply synchronized playback. Press I'm ready to retry.");
          setLocalPlayback((value) => {
            const next = { ...value, ready: false };
            localPlaybackRef.current = next;
            return next;
          });
        }
      }
    } finally {
      guestPlaybackRunningRef.current = false;
    }
  }, []);

  const handleChannelMessage = useCallback(async (peerId, event) => {
    let message;
    try { message = JSON.parse(event.data); }
    catch { return; }
    const current = roomRef.current;
    if (!current) return;
    if (current.role === "host") {
      if (message.type === "ready") {
        const hostDuration = Number(playerRef.current?.getState()?.duration) || 0;
        const compatible = Boolean(message.ready) && durationsCompatible(hostDuration, message.duration);
        updatePeerState(peerId, {
          ready: Boolean(message.ready) && compatible,
          compatible,
          duration: Number(message.duration) || 0,
          buffering: Boolean(message.buffering),
        });
      } else if (message.type === "buffering") {
        updatePeerState(peerId, { buffering: Boolean(message.buffering) });
      } else if (message.type === "seek-ready" || message.type === "seek-failed") {
        const transition = activeSeekRef.current;
        if (!transition || !Number.isSafeInteger(message.id) || message.id !== transition.id
          || !transition.required.has(peerId)) return;
        if (message.type === "seek-ready") {
          transition.ready.add(peerId);
          updatePeerState(peerId, { syncing: false, syncFailed: false });
          completeSeekIfReady();
        } else {
          transition.ready.delete(peerId);
          updatePeerState(peerId, { syncing: false, syncFailed: true });
        }
      } else if (message.type === "ping") {
        sendChannel(peersRef.current.get(peerId)?.channel, { type: "pong", id: message.id, hostAt: Date.now() });
      }
      return;
    }
    if (message.type === "seek-start") {
      if (!Number.isSafeInteger(message.id) || message.id <= 0
        || !Number.isFinite(message.position) || message.position < 0
        || message.id <= (guestSeekRef.current?.id || 0)) return;
      const transition = { id: message.id, position: message.position };
      guestSeekRef.current = transition;
      void performGuestSeek(transition);
    } else if (message.type === "roster" && Array.isArray(message.participants)) {
      const ownStatus = message.participants.find((participant) => participant.id === current.participantId);
      if (ownStatus) {
        setLocalPlayback((value) => {
          const next = { ...value, compatible: ownStatus.compatible !== false,
            ready: Boolean(ownStatus.ready) && ownStatus.compatible !== false };
          localPlaybackRef.current = next;
          return next;
        });
      }
      setPeerRoster((currentRoster) => ({
        ...currentRoster,
        ...Object.fromEntries(message.participants.map((participant) => [participant.id,
          { ...currentRoster[participant.id], ...participant }])),
      }));
    } else if (message.type === "pong") {
      const sentAt = pingRef.current.get(message.id);
      if (sentAt) {
        clockOffsetRef.current = estimateClockOffset({ sentAt, hostAt: message.hostAt, receivedAt: Date.now() });
        pingRef.current.delete(message.id);
      }
    } else if (message.type === "playback" && Number.isSafeInteger(message.sequence)
      && message.sequence > guestSequenceRef.current) {
      guestSequenceRef.current = message.sequence;
      pendingGuestPlaybackRef.current = message;
      void drainGuestPlayback();
    }
  }, [completeSeekIfReady, drainGuestPlayback, performGuestSeek, sendChannel, updatePeerState]);

  const wirePeer = useCallback((peerId, pc, channel = null) => {
    const peer = { pc, channel, closing: false, disconnectTimer: null, retryTimer: null };
    peersRef.current.set(peerId, peer);
    updatePeerState(peerId, { channel: "connecting" });
    const restorePeer = () => {
      if (peer.closing || peersRef.current.get(peerId) !== peer) return;
      clearTimeout(peer.disconnectTimer);
      peer.disconnectTimer = null;
      peerRecoveryAttemptsRef.current.set(peerId, 0);
      updatePeerState(peerId, { channel: "connected" });
    };
    const failPeer = (state = "failed") => {
      if (peer.closing || peersRef.current.get(peerId) !== peer) return;
      clearTimeout(peer.disconnectTimer);
      peer.disconnectTimer = null;
      if (roomRef.current?.role !== "host") {
        updatePeerState(peerId, { channel: state, ready: false, syncing: false, syncFailed: false });
        return;
      }
      const attempts = (peerRecoveryAttemptsRef.current.get(peerId) || 0) + 1;
      peerRecoveryAttemptsRef.current.set(peerId, attempts);
      if (attempts > 3) {
        updatePeerState(peerId, { channel: state, ready: false, syncing: false,
          syncFailed: Boolean(activeSeekRef.current) });
        return;
      }
      activeSeekRef.current?.ready.delete(peerId);
      updatePeerState(peerId, { channel: "reconnecting", ready: false,
        syncing: Boolean(activeSeekRef.current), syncFailed: false });
      peer.retryTimer = setTimeout(() => {
        if (!peer.closing && peersRef.current.get(peerId) === peer) {
          void createHostPeerRef.current?.(peerId).catch(() => {});
        }
      }, Math.min(3_000, attempts * 750));
    };
    const waitForPeerRecovery = () => {
      if (peer.closing || peersRef.current.get(peerId) !== peer) return;
      updatePeerState(peerId, { channel: "reconnecting" });
      if (peer.disconnectTimer) return;
      peer.disconnectTimer = setTimeout(() => {
        if (pc.connectionState === "connected") restorePeer();
        else failPeer("failed");
      }, 10_000);
    };
    const bindChannel = (nextChannel) => {
      peer.channel = nextChannel;
      nextChannel.onopen = () => {
        restorePeer();
        const current = roomRef.current;
        if (current?.role === "guest") {
          const pingId = crypto.randomUUID();
          pingRef.current.set(pingId, Date.now());
          sendChannel(nextChannel, { type: "ping", id: pingId });
          const local = localPlaybackRef.current;
          sendChannel(nextChannel, { type: "ready", ready: local.ready,
            buffering: local.buffering, duration: local.duration });
        } else {
          const transition = activeSeekRef.current;
          if (transition) {
            transition.required.add(peerId);
            updatePeerState(peerId, { syncing: true, syncFailed: false });
            sendChannel(nextChannel, { type: "seek-start", id: transition.id, position: transition.position });
          }
          publishRoster();
        }
      };
      nextChannel.onclose = () => {
        if (!peer.closing) failPeer("disconnected");
      };
      nextChannel.onerror = () => waitForPeerRecovery();
      nextChannel.onmessage = (event) => void handleChannelMessage(peerId, event);
    };
    if (channel) bindChannel(channel);
    else pc.ondatachannel = (event) => bindChannel(event.channel);
    pc.onicecandidate = (event) => {
      if (event.candidate) sendSignal({ type: "relay", targetId: peerId, kind: "ice", payload: event.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") restorePeer();
      else if (pc.connectionState === "disconnected") waitForPeerRecovery();
      else if (["failed", "closed"].includes(pc.connectionState)) failPeer(pc.connectionState);
    };
    return peer;
  }, [handleChannelMessage, publishRoster, sendChannel, sendSignal, updatePeerState]);

  const createHostPeer = useCallback(async (participantId) => {
    closePeer(peersRef.current.get(participantId));
    const pc = new RTCPeerConnection({ iceServers: [{ urls: configRef.current.stunUrls }] });
    const channel = pc.createDataChannel("torplay-watch", { ordered: true });
    wirePeer(participantId, pc, channel);
    await pc.setLocalDescription(await pc.createOffer());
    sendSignal({ type: "relay", targetId: participantId, kind: "offer", payload: pc.localDescription.toJSON() });
  }, [sendSignal, wirePeer]);

  useEffect(() => { createHostPeerRef.current = createHostPeer; }, [createHostPeer]);

  const acceptSignal = useCallback(async (message) => {
    const current = roomRef.current;
    if (!current) return;
    let peer = peersRef.current.get(message.fromId);
    if (message.kind === "offer" && current.role === "guest") {
      closePeer(peer);
      const pc = new RTCPeerConnection({ iceServers: [{ urls: configRef.current.stunUrls }] });
      peer = wirePeer(message.fromId, pc);
      await pc.setRemoteDescription(message.payload);
      for (const candidate of pendingIceRef.current.get(message.fromId) || []) {
        await pc.addIceCandidate(candidate).catch(() => {});
      }
      pendingIceRef.current.delete(message.fromId);
      await pc.setLocalDescription(await pc.createAnswer());
      sendSignal({ type: "relay", targetId: message.fromId, kind: "answer", payload: pc.localDescription.toJSON() });
    } else if (message.kind === "answer" && current.role === "host" && peer) {
      await peer.pc.setRemoteDescription(message.payload);
      for (const candidate of pendingIceRef.current.get(message.fromId) || []) {
        await peer.pc.addIceCandidate(candidate).catch(() => {});
      }
      pendingIceRef.current.delete(message.fromId);
    } else if (message.kind === "ice") {
      if (peer?.pc.remoteDescription) await peer.pc.addIceCandidate(message.payload).catch(() => {});
      else pendingIceRef.current.set(message.fromId,
        [...(pendingIceRef.current.get(message.fromId) || []), message.payload]);
    }
  }, [sendSignal, wirePeer]);

  const resetMediaState = useCallback((media) => {
    playerRef.current?.pause();
    activeSeekRef.current = null;
    guestSeekRef.current = null;
    pendingGuestPlaybackRef.current = null;
    setRoom((current) => current ? { ...current, media } : current);
    setPeerRoster((current) => Object.fromEntries(
      [...new Set([...Object.keys(current), ...peersRef.current.keys()])].map((participantId) => {
        const previous = current[participantId] || {};
        const peer = peersRef.current.get(participantId);
        return [participantId, {
          ...previous,
          ready: false,
          buffering: false,
          compatible: true,
          duration: 0,
          syncing: false,
          syncFailed: false,
          channel: peer?.channel?.readyState === "open"
            ? "connected" : previous.channel || "connecting",
        }];
      }),
    ));
    const empty = { attached: false, canPlay: false, ready: false, buffering: false, duration: 0, compatible: true,
      syncing: false, syncFailed: false };
    localPlaybackRef.current = empty;
    setLocalPlayback(empty);
    guestSequenceRef.current = 0;
    playbackSequenceRef.current = 0;
    playerRef.current = null;
  }, []);

  const handleSocketMessage = useCallback((event) => {
    let message;
    try { message = JSON.parse(event.data); }
    catch { return; }
    if (message.type === "error") {
      setError(message.message || "Watch Together failed.");
      pendingOpenRef.current?.reject(new Error(message.message || "Watch Together failed."));
      pendingOpenRef.current = null;
    } else if (message.type === "room") {
      const nextRoom = {
        code: message.code, participantId: message.participantId, reconnectToken: message.reconnectToken,
        role: message.role, media: normalizeMediaIdentity(message.media), expiresAt: message.expiresAt,
      };
      roomRef.current = nextRoom;
      setRoom(nextRoom);
      setServerRoster(message.participants || []);
      setConnectionState("connected");
      setError("");
      saveSession(nextRoom);
      if (nextRoom.role === "host") {
        queueMicrotask(() => {
          for (const participant of message.participants || []) {
            if (participant.role === "guest" && participant.connected) {
              void createHostPeer(participant.id).catch(() => setError("A participant connection could not be restored."));
            }
          }
        });
      }
      pendingOpenRef.current?.resolve(nextRoom);
      pendingOpenRef.current = null;
    } else if (message.type === "roster") {
      setServerRoster(message.participants || []);
    } else if (message.type === "peer-joined" && roomRef.current?.role === "host") {
      const state = playerRef.current?.getState();
      if (state?.playing) {
        playerRef.current.pause();
        playbackSequenceRef.current += 1;
        broadcastChannel({ type: "playback", sequence: playbackSequenceRef.current,
          position: state.position, playing: false, sentAt: Date.now(), explicit: true });
      }
      void createHostPeer(message.participant.id).catch(() => setError("A participant connection could not be created."));
    } else if (message.type === "peer-left") {
      closePeer(peersRef.current.get(message.participantId));
      peersRef.current.delete(message.participantId);
      peerRecoveryAttemptsRef.current.delete(message.participantId);
      activeSeekRef.current?.required.delete(message.participantId);
      completeSeekIfReady();
      setPeerRoster((current) => {
        const next = { ...current };
        delete next[message.participantId];
        return next;
      });
    } else if (message.type === "signal") {
      void acceptSignal(message).catch(() => setError("WebRTC negotiation failed. Check the network and try again."));
    } else if (message.type === "media-changed") {
      const media = normalizeMediaIdentity(message.media);
      resetMediaState(media);
      router.push(mediaIdentityHref(media));
    } else if (message.type === "room-closed") {
      setError(message.reason === "expired" ? "The room expired." : "The host closed the room.");
      reconnectRef.current.intentional = true;
      saveSession(null);
      roomRef.current = null;
      activeSeekRef.current = null;
      guestSeekRef.current = null;
      pendingGuestPlaybackRef.current = null;
      setRoom(null);
      setServerRoster([]);
      setConnectionState("closed");
      for (const peer of peersRef.current.values()) closePeer(peer);
      peersRef.current.clear();
      peerRecoveryAttemptsRef.current.clear();
    }
  }, [acceptSignal, broadcastChannel, completeSeekIfReady, createHostPeer, resetMediaState, router]);

  const openSocket = useCallback((openingMessage) => new Promise((resolve, reject) => {
    if (!configRef.current.signalUrl) return reject(new Error("Configure a Watch Together signaling service first."));
    const socket = new WebSocket(configRef.current.signalUrl);
    socketRef.current = socket;
    pendingOpenRef.current = { resolve, reject };
    setConnectionState("connecting");
    socket.onopen = () => socket.send(JSON.stringify({ protocol: WATCH_TOGETHER_PROTOCOL_VERSION, ...openingMessage }));
    socket.onmessage = handleSocketMessage;
    socket.onerror = () => {
      const failure = new Error("The Watch Together signaling service could not be reached.");
      setError(failure.message);
      pendingOpenRef.current?.reject(failure);
      pendingOpenRef.current = null;
    };
    socket.onclose = () => {
      if (socketRef.current !== socket || reconnectRef.current.intentional) return;
      setConnectionState("reconnecting");
      const current = roomRef.current;
      if (!current || reconnectRef.current.attempts >= 5) {
        setError("The Watch Together connection was lost.");
        return;
      }
      reconnectRef.current.attempts += 1;
      reconnectRef.current.timer = setTimeout(() => {
        void openSocketRef.current?.({ type: "resume", code: current.code, participantId: current.participantId,
          reconnectToken: current.reconnectToken }).catch(() => {});
      }, Math.min(3_000, reconnectRef.current.attempts * 500));
    };
  }), [handleSocketMessage]);

  useEffect(() => { openSocketRef.current = openSocket; }, [openSocket]);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/watch-together/config", { cache: "no-store" }).then(readJson).then((value) => {
      if (cancelled) return;
      const next = { ...value, loading: false };
      setConfig(next);
      configRef.current = next;
      const previous = storedSession();
      if (next.enabled && previous?.code && previous?.participantId && previous?.reconnectToken) {
        reconnectRef.current.intentional = false;
        void openSocketRef.current?.({ type: "resume", code: previous.code, participantId: previous.participantId,
          reconnectToken: previous.reconnectToken }).catch(() => saveSession(null));
      }
    }).catch((loadError) => {
      if (!cancelled) setConfig({ loading: false, enabled: false, signalUrl: null, stunUrls: [], error: loadError.message });
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (room?.role !== "host" || !allReady) return undefined;
    const timer = setInterval(() => {
      if (playerRef.current?.getState()?.playing) playbackSnapshot(false);
    }, WATCH_TOGETHER_SNAPSHOT_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [allReady, playbackSnapshot, room?.role]);

  useEffect(() => {
    if (room?.role !== "host" || !allReady || !resumeAfterMediaChangeRef.current) return;
    const player = playerRef.current;
    if (!player) return;
    resumeAfterMediaChangeRef.current = false;
    void player.play().then(() => playbackSnapshot(true)).catch(() => {
      setError("Your browser needs another click before synchronized playback can continue.");
      setLocalPlayback((value) => {
        const next = { ...value, ready: false };
        localPlaybackRef.current = next;
        return next;
      });
    });
  }, [allReady, playbackSnapshot, room?.role]);

  useEffect(() => () => {
    reconnectRef.current.intentional = true;
    clearTimeout(reconnectRef.current.timer);
    try { socketRef.current?.close(); } catch {}
    for (const peer of peersRef.current.values()) closePeer(peer);
  }, []);

  const createRoom = useCallback(async (media) => {
    setError("");
    reconnectRef.current = { timer: null, attempts: 0, intentional: false };
    const name = profile?.activeProfile?.name || "Host";
    return openSocket({ type: "create", name, media: normalizeMediaIdentity(media) });
  }, [openSocket, profile?.activeProfile?.name]);

  const joinRoom = useCallback(async (code) => {
    setError("");
    reconnectRef.current = { timer: null, attempts: 0, intentional: false };
    const name = profile?.activeProfile?.name || "Guest";
    const joined = await openSocket({ type: "join", name, code: normalizeRoomCode(code) });
    router.push(mediaIdentityHref(joined.media));
    return joined;
  }, [openSocket, profile?.activeProfile?.name, router]);

  const leaveRoom = useCallback(() => {
    reconnectRef.current.intentional = true;
    clearTimeout(reconnectRef.current.timer);
    sendSignal({ type: "leave" });
    try { socketRef.current?.close(); } catch {}
    for (const peer of peersRef.current.values()) closePeer(peer);
    peersRef.current.clear();
    peerRecoveryAttemptsRef.current.clear();
    playerRef.current = null;
    resumeAfterMediaChangeRef.current = false;
    activeSeekRef.current = null;
    guestSeekRef.current = null;
    pendingGuestPlaybackRef.current = null;
    saveSession(null);
    roomRef.current = null;
    setRoom(null);
    setServerRoster([]);
    setPeerRoster({});
    setConnectionState("idle");
    const empty = { attached: false, canPlay: false, ready: false, buffering: false, duration: 0, compatible: true,
      syncing: false, syncFailed: false };
    localPlaybackRef.current = empty;
    setLocalPlayback(empty);
  }, [sendSignal]);

  const changeMedia = useCallback((media) => {
    const normalized = normalizeMediaIdentity(media);
    if (roomRef.current?.role !== "host") return false;
    resumeAfterMediaChangeRef.current = true;
    sendSignal({ type: "change-media", media: normalized });
    resetMediaState(normalized);
    return true;
  }, [resetMediaState, sendSignal]);

  const seekTogether = useCallback((position) => {
    const current = roomRef.current;
    const player = playerRef.current;
    const target = Number(position);
    if (current?.role !== "host" || !player || !Number.isFinite(target) || target < 0 || !allReady) return false;
    seekSequenceRef.current += 1;
    const transition = {
      id: seekSequenceRef.current,
      position: target,
      resumePlaying: Boolean(player.getState().playing),
      localReady: false,
      required: new Set(),
      ready: new Set(),
    };
    for (const participant of serverRoster) {
      if (participant.id === current.participantId || !participant.connected) continue;
      const peer = peersRef.current.get(participant.id);
      if (peer?.channel?.readyState === "open") transition.required.add(participant.id);
    }
    activeSeekRef.current = transition;
    setError("");
    setLocalPlayback((value) => {
      const next = { ...value, syncing: true, syncFailed: false };
      localPlaybackRef.current = next;
      return next;
    });
    for (const participantId of transition.required) {
      updatePeerState(participantId, { syncing: true, syncFailed: false });
    }
    void performHostSeek(transition);
    broadcastChannel({ type: "seek-start", id: transition.id, position: transition.position });
    return true;
  }, [allReady, broadcastChannel, performHostSeek, serverRoster, updatePeerState]);

  const retrySeekSync = useCallback(() => {
    setError("");
    if (roomRef.current?.role === "host") return performHostSeek();
    return performGuestSeek();
  }, [performGuestSeek, performHostSeek]);

  const attachPlayer = useCallback((media, controller) => {
    const current = roomRef.current;
    if (!current || !sameMediaIdentity(current.media, media)) return () => {};
    playerRef.current = controller;
    setLocalPlayback((value) => {
      const next = { ...value, attached: true, canPlay: false, ready: false,
        buffering: false, duration: 0, compatible: true, syncing: false, syncFailed: false };
      localPlaybackRef.current = next;
      return next;
    });
    return () => {
      if (playerRef.current !== controller) return;
      playerRef.current = null;
      setLocalPlayback((value) => {
        const next = { ...value, attached: false, canPlay: false, ready: false, buffering: false, duration: 0 };
        localPlaybackRef.current = next;
        return next;
      });
    };
  }, []);

  const reportPlayer = useCallback((patch) => {
    setLocalPlayback((value) => {
      const next = { ...value, ...patch };
      localPlaybackRef.current = next;
      const current = roomRef.current;
      if (current?.role === "guest") {
        const host = [...peersRef.current.values()][0];
        if (patch.buffering !== undefined) sendChannel(host?.channel, { type: "buffering", buffering: next.buffering });
      }
      return next;
    });
  }, [sendChannel]);

  const markReady = useCallback(async () => {
    const player = playerRef.current;
    if (!player || !localPlayback.canPlay || !(localPlayback.duration > 0)) return false;
    await player.prime();
    setError("");
    setLocalPlayback((value) => {
      const next = { ...value, ready: true };
      localPlaybackRef.current = next;
      return next;
    });
    const current = roomRef.current;
    if (current?.role === "guest") {
      const host = [...peersRef.current.values()][0];
      sendChannel(host?.channel, { type: "ready", ready: true, buffering: localPlayback.buffering,
        duration: localPlayback.duration });
    }
    return true;
  }, [localPlayback, sendChannel]);

  const value = useMemo(() => ({
    config, room, pageMedia, participants: mergedParticipants, connectionState, error, localPlayback, allReady, seekSyncing,
    isHost: room?.role === "host", isGuest: room?.role === "guest",
    createRoom, joinRoom, leaveRoom, changeMedia, seekTogether, retrySeekSync, attachPlayer, reportPlayer, markReady,
    registerPageMedia,
    broadcastPlayback: playbackSnapshot,
    matchesMedia: (media) => Boolean(room && sameMediaIdentity(room.media, media)),
  }), [allReady, attachPlayer, changeMedia, config, connectionState, createRoom, error, joinRoom,
    leaveRoom, localPlayback, markReady, mergedParticipants, pageMedia, playbackSnapshot, registerPageMedia,
    reportPlayer, retrySeekSync, room, seekSyncing, seekTogether]);

  return <WatchTogetherContext.Provider value={value}>{children}</WatchTogetherContext.Provider>;
}

export function useWatchTogether() {
  const context = useContext(WatchTogetherContext);
  if (!context) throw new Error("useWatchTogether must be used inside WatchTogetherProvider.");
  return context;
}

export function useOptionalWatchTogether() {
  return useContext(WatchTogetherContext);
}
