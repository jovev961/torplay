"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { copyText } from "./copyText.js";
import { mediaIdentityHref } from "../lib/watch-together/protocol.js";
import { useWatchTogether } from "./WatchTogetherProvider.js";

function statusLabel(participant) {
  if (!participant.connected || participant.channel === "disconnected") return "Disconnected";
  if (participant.channel === "reconnecting") return "Reconnecting…";
  if (participant.channel === "failed") return "Connection failed";
  if (participant.channel !== "connected") return "Connecting…";
  if (!participant.compatible) return "Choose another source";
  if (participant.syncFailed) return "Sync failed";
  if (participant.syncing) return "Seeking…";
  if (participant.buffering) return "Buffering";
  if (participant.ready) return "Ready";
  return "Not ready";
}

function TogetherIcon() {
  return (
    <svg className="watchTogetherIcon" aria-hidden="true" viewBox="0 0 24 24" focusable="false">
      <path d="M8.5 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zm7-1a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM8.5 13C4.36 13 2 15.04 2 18v2h13v-2c0-2.96-2.36-5-6.5-5zm7 0c-.5 0-.96.04-1.4.11A6.2 6.2 0 0 1 17 18v2h5v-2c0-3-2.3-5-6.5-5z" />
    </svg>
  );
}

export default function WatchTogetherDock() {
  const router = useRouter();
  const party = useWatchTogether();
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState("");
  const [localError, setLocalError] = useState("");
  const roomMatchesPage = Boolean(party.pageMedia && party.matchesMedia(party.pageMedia));

  async function copyCode() {
    const copiedValue = await copyText(party.room.code);
    setCopied(copiedValue);
    setTimeout(() => setCopied(false), 1_500);
  }

  async function createRoom() {
    if (!party.pageMedia) return;
    setBusy("create");
    setLocalError("");
    try { await party.createRoom(party.pageMedia); }
    catch (error) { setLocalError(error.message); }
    finally { setBusy(""); }
  }

  async function joinRoom(event) {
    event.preventDefault();
    setBusy("join");
    setLocalError("");
    try { await party.joinRoom(code); }
    catch (error) { setLocalError(error.message); }
    finally { setBusy(""); }
  }

  if (!expanded) return (
    <aside className={`watchTogetherDock collapsed ${party.room ? "active" : ""}`} aria-label="Watch Together">
      <button className="watchTogetherLauncher" type="button" aria-label="Open Watch Together"
        onClick={() => setExpanded(true)}>
        <TogetherIcon />
        {party.room ? <span className="watchTogetherLauncherStatus" aria-hidden="true" /> : null}
      </button>
    </aside>
  );

  return (
    <aside className="watchTogetherDock expanded" aria-label="Watch Together">
      <div className="watchTogetherDockHeader">
        <span className="watchTogetherDockTitle"><TogetherIcon />Watch Together</span>
        {party.room ? <strong>{party.room.code}</strong> : null}
        <button type="button" className="watchTogetherMinimize" onClick={() => setExpanded(false)}
          aria-label="Minimize Watch Together">&minus;</button>
      </div>
      <div className="watchTogetherDockBody">
        {!party.room ? <div className="watchTogetherSetup">
          <p>Create a room for the current movie or episode, or join with a room code.</p>
          <button className="primaryButton compact" type="button" disabled={party.config.loading
            || !party.config.enabled || !party.pageMedia || Boolean(busy)} onClick={() => void createRoom()}>
            {busy === "create" ? "Creating room…" : "Create room"}
          </button>
          {!party.pageMedia ? <small>Open a movie or select an episode to create a room.</small> : null}
          <div className="watchTogetherDivider"><span>or join</span></div>
          <form onSubmit={joinRoom}>
            <label htmlFor="watch-together-dock-code">Room code</label>
            <input id="watch-together-dock-code" value={code} maxLength="6" autoCapitalize="characters"
              autoComplete="off" spellCheck="false" placeholder="ABC234"
              onChange={(event) => setCode(event.target.value.replace(/[^a-z0-9]/gi, "").toUpperCase())} />
            <button className="secondaryButton compact" type="submit" disabled={party.config.loading
              || !party.config.enabled || code.length !== 6 || Boolean(busy)}>
              {busy === "join" ? "Joining…" : "Join room"}
            </button>
          </form>
          {!party.config.loading && !party.config.enabled ? (
            <small>Configure a Watch Together signaling service in Settings first.</small>
          ) : null}
          {localError || party.error ? <p className="watchTogetherError" role="alert">{localError || party.error}</p> : null}
        </div> : <>
        <div className="watchTogetherCodeRow">
          <span>Room code</span>
          <button type="button" onClick={() => void copyCode()}>{copied ? "Copied" : "Copy code"}</button>
        </div>
        <div className="watchTogetherRoster">
          {party.participants.map((participant) => (
            <div className="watchTogetherParticipant" key={participant.id}>
              <span className={`watchTogetherStatus ${participant.ready ? "ready" : ""}`} aria-hidden="true" />
              <span><strong>{participant.name}</strong>{participant.role === "host" ? <small>Host</small> : null}</span>
              <small>{statusLabel(participant)}</small>
            </div>
          ))}
        </div>
        {party.localPlayback.attached && party.localPlayback.canPlay && !party.localPlayback.ready ? (
          <button className="primaryButton compact" type="button" onClick={() => void party.markReady()}>
            I&apos;m ready
          </button>
        ) : null}
        {party.localPlayback.syncFailed ? (
          <button className="primaryButton compact" type="button" onClick={() => void party.retrySeekSync()}>
            Retry sync
          </button>
        ) : null}
        {!party.localPlayback.attached ? (
          <button className="secondaryButton compact" type="button"
            onClick={() => router.push(mediaIdentityHref(party.room.media))}>Open room media</button>
        ) : null}
        {party.isHost && party.pageMedia && !roomMatchesPage ? (
          <button className="secondaryButton compact" type="button"
            onClick={() => party.changeMedia(party.pageMedia)}>Move room here</button>
        ) : null}
        {party.seekSyncing ? <small className="watchTogetherHint">Waiting for everyone to reach the shared position.</small> : null}
        {party.isHost && !party.allReady && !party.seekSyncing
          ? <small className="watchTogetherHint">Playback unlocks when everyone is ready.</small> : null}
        {party.isGuest ? <small className="watchTogetherHint">The host controls playback and episode changes.</small> : null}
        {party.error ? <p className="watchTogetherError" role="alert">{party.error}</p> : null}
        <button className="watchTogetherLeave" type="button" onClick={party.leaveRoom}>Leave room</button>
        </>}
      </div>
    </aside>
  );
}
