"use client";

import { useEffect, useState } from "react";
import styles from "./DebridSettings.module.css";

const names = { "real-debrid": "Real-Debrid", torbox: "TorBox" };
async function request(url, body, method = "POST") {
  const response = await fetch(url, {
    method, headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body), cache: "no-store",
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "The provider request failed.");
  return result;
}

export default function DebridSettings({ canEdit, section = "playback" }) {
  const [config, setConfig] = useState(null);
  const [draft, setDraft] = useState(null);
  const [status, setStatus] = useState({});
  const [flow, setFlow] = useState(null);
  const [keys, setKeys] = useState({ "real-debrid": "", torbox: "" });
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");

  async function refresh() {
    const response = await fetch("/api/settings/debrid", { cache: "no-store" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not load debrid settings.");
    setConfig(result);
    setDraft({
      mode: result.mode, priority: result.priority, localFallback: result.localFallback,
      unavailableAction: result.unavailableAction,
    });
  }

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/settings/debrid", { cache: "no-store" })
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Could not load debrid settings.");
        return result;
      })
      .then((result) => {
        if (cancelled) return;
        setConfig(result);
        setDraft({ mode: result.mode, priority: result.priority, localFallback: result.localFallback,
          unavailableAction: result.unavailableAction });
        if (section !== "services") return;
        for (const [provider, details] of Object.entries(result.providers)) {
          if (!details.configured) continue;
          void request(`/api/settings/debrid/${provider}`, { action: "test" })
            .then((checked) => {
              if (!cancelled) setStatus((current) => ({ ...current, [provider]: checked.status }));
            })
            .catch(() => {
              if (!cancelled) setStatus((current) => ({ ...current, [provider]: "Unavailable" }));
            });
        }
      })
      .catch((error) => { if (!cancelled) setMessage(error.message); });
    return () => { cancelled = true; };
  }, [section]);

  useEffect(() => {
    if (!flow) return undefined;
    const interval = setInterval(async () => {
      if (Date.now() > flow.expiresAt) {
        setFlow(null);
        setStatus((current) => ({ ...current, [flow.provider]: "expired" }));
        return;
      }
      try {
        const result = await request(`/api/settings/debrid/${flow.provider}`,
          { action: "poll", flowId: flow.id });
        if (result.status !== "connecting") {
          setFlow(null);
          setStatus((current) => ({ ...current, [flow.provider]: result.status }));
          if (result.status === "connected") await refresh();
        }
      } catch (error) {
        setFlow(null);
        setMessage(error.message);
      }
    }, flow.interval * 1000);
    return () => clearInterval(interval);
  }, [flow]);

  async function perform(provider, action, extra = {}) {
    setBusy(`${provider}:${action}`);
    setMessage("");
    try {
      const result = await request(`/api/settings/debrid/${provider}`,
        { action, ...extra });
      if (action === "start") {
        setFlow({ ...result, provider });
        setStatus((current) => ({ ...current, [provider]: "connecting" }));
      } else {
        setStatus((current) => ({ ...current, [provider]: result.status }));
        if (action === "key") {
          setKeys((current) => ({ ...current, [provider]: "" }));
          setFlow(null);
        }
        if (["key", "disconnect"].includes(action)) await refresh();
      }
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy("");
    }
  }

  async function savePolicy() {
    setBusy("policy");
    setMessage("");
    try {
      setConfig((current) => ({ ...current, ...draft }));
      await request("/api/settings/debrid", draft, "PATCH");
      setMessage("Debrid settings saved.");
    } catch (error) {
      setMessage(error.message);
      await refresh();
    } finally {
      setBusy("");
    }
  }

  if (!draft || !config) return <p>Loading optional debrid settings…</p>;
  const second = draft.priority.find((id) => id !== draft.priority[0]);
  return section === "playback" ? (
    <div className={styles.layout}>
      <div className={styles.card}>
        <span className={styles.kicker}>Playback preference</span>
        <h3>How should TorPlay play videos?</h3>
        <p>Choose whether to stream from torrent peers or check your connected provider accounts first.</p>
        <label>Preferred playback method
          <select disabled={!canEdit || Boolean(busy)} value={draft.mode}
            onChange={(event) => setDraft({ ...draft, mode: event.target.value })}>
            <option value="local">Local BitTorrent Only</option>
            <option value="prefer-debrid">Prefer Debrid</option>
            <option value="debrid-only">Debrid Only</option>
          </select>
        </label>
        {draft.mode === "prefer-debrid" ? (
          <label className={styles.check}>
            <input type="checkbox" checked={draft.localFallback}
              disabled={!canEdit || Boolean(busy)}
              onChange={(event) => setDraft({ ...draft, localFallback: event.target.checked })} />
            Allow local BitTorrent when neither provider has the requested file
          </label>
        ) : null}
        {draft.mode !== "local" ? <label>When the video is not ready on a provider
          <select disabled={!canEdit || Boolean(busy)} value={draft.unavailableAction}
            onChange={(event) => setDraft({ ...draft, unavailableAction: event.target.value })}>
            <option value="ask">Ask me</option>
            <option value="local" disabled={draft.mode === "debrid-only" || !draft.localFallback}>Watch immediately with local BitTorrent</option>
            <option value="remote">Download using my preferred debrid provider</option>
          </select>
        </label> : null}
        <button type="button" disabled={!canEdit || Boolean(busy)
          || (draft.mode === config.mode && draft.localFallback === config.localFallback
            && draft.unavailableAction === config.unavailableAction)}
          onClick={savePolicy}>Save playback method</button>
      </div>
      {message ? <p role="status">{message}</p> : null}
    </div>
  ) : (
    <div className={styles.layout}>
      <div className={styles.card}>
        <span className={styles.kicker}>Provider order</span>
        <h3>Which provider should TorPlay check first?</h3>
        <p>If both accounts are connected, TorPlay checks your preferred provider first.</p>
        <label>Preferred provider
          <select disabled={!canEdit || Boolean(busy)} value={draft.priority[0]}
            onChange={(event) => setDraft({ ...draft, priority: [event.target.value,
              event.target.value === "real-debrid" ? "torbox" : "real-debrid"] })}>
            <option value="real-debrid">Real-Debrid</option>
            <option value="torbox">TorBox</option>
          </select>
        </label>
        <p>Next provider: {names[second]}</p>
        <button type="button" disabled={!canEdit || Boolean(busy)
          || draft.priority[0] === config.priority[0]}
          onClick={savePolicy}>Save preferred provider</button>
      </div>
      <div className={styles.grid}>
        {Object.keys(names).map((provider) => (
          <div className={styles.card} key={provider}>
            <h3>{names[provider]}</h3>
            <span className={config.providers[provider]?.configured ? styles.connected : styles.disconnected}>
              {status[provider] || (config.providers[provider]?.configured ? "Configured" : "Not connected")}
            </span>
            {provider === "real-debrid"
              ? <p>Plays completed account torrents immediately, or downloads a selected torrent when you choose it.</p>
              : <p>Plays ready cached files immediately, or downloads a selected torrent when you choose it.</p>}
            {flow?.provider === provider ? (
              <div className={styles.code}>
                <p>Enter code <strong>{flow.userCode}</strong> at{" "}
                  <a href={flow.verificationUrl} target="_blank" rel="noreferrer">the provider verification page ↗</a>.
                </p>
                <p>Waiting for authorization…</p>
              </div>
            ) : null}
            {canEdit ? (
              <div className={styles.actions}>
                <button type="button" disabled={Boolean(busy) || Boolean(flow)}
                  onClick={() => perform(provider, "start")}>{config.providers[provider]?.configured ? "Reconnect" : "Connect account"}</button>
                <button type="button" disabled={Boolean(busy) || !config.providers[provider]?.configured}
                  onClick={() => perform(provider, "test")}>Test connection</button>
                <button type="button" disabled={Boolean(busy) || !config.providers[provider]?.configured}
                  onClick={() => perform(provider, "disconnect")}>Disconnect</button>
              </div>
            ) : null}
            {canEdit ? (
              <details className={styles.key}>
                <summary>Use an API key instead</summary>
                <label>{provider === "real-debrid" ? "Private API token" : "API key"}
                  <input type="password" autoComplete="new-password" value={keys[provider]}
                    disabled={Boolean(busy) || Boolean(flow)}
                    placeholder={config.providers[provider]?.configured ? "Leave blank to keep current credential" : ""}
                    onChange={(event) => setKeys((current) => ({ ...current, [provider]: event.target.value }))} />
                </label>
                <button type="button" disabled={Boolean(busy) || Boolean(flow) || !keys[provider].trim()}
                  onClick={() => perform(provider, "key", { apiKey: keys[provider] })}>Save and test key</button>
              </details>
            ) : null}
          </div>
        ))}
      </div>
      {message ? <p role="status">{message}</p> : null}
    </div>
  );
}
