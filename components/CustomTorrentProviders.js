"use client";

import { useEffect, useState } from "react";
import styles from "./SettingsManager.module.css";

async function request(action, provider, refresh = false) {
  const response = await fetch("/api/settings/torrent-providers", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, provider, refresh }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Provider request failed.");
  return body;
}
export default function CustomTorrentProviders({ initialProviders, canEdit, onChanged, addOpen = false, onAddClosed }) {
  const [providers, setProviders] = useState(initialProviders);
  const [draft, setDraft] = useState(null);
  const [health, setHealth] = useState({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  async function refresh(force = false) {
    try {
      const data = await request("health", undefined, force);
      setHealth(Object.fromEntries(data.results.map((item) => [item.provider, item])));
    } catch (err) { setError(err.message); }
  }
  useEffect(() => {
    let cancelled = false;
    request("health").then((data) => {
      if (!cancelled) setHealth(Object.fromEntries(data.results.map((item) => [item.provider, item])));
    }).catch((err) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, []);
  const activeDraft = draft || (addOpen ? { name: "", endpoint: "", apiKey: "", enabled: true } : null);
  async function act(action, provider) {
    setBusy(true); setError(""); setMessage("");
    try {
      const data = await request(action, provider);
      if (action === "test") setMessage(`Connected · ${data.capabilities.mediaTypes.join(" · ")}`);
      else {
        setProviders(data.providers); setDraft(null); onAddClosed?.();
        setMessage(action === "remove" ? "Provider removed." : "Provider saved.");
        await onChanged();
        await refresh(true);
      }
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  return (
    <div className={styles.providerGrid}>
      <h3>Custom Providers</h3>
      <p className={styles.sectionNote}>Optional Torznab sources such as Prowlarr or your own indexer. Built-in sources work without them.</p>
      {providers.map((provider) => (
        <article className={styles.providerCard} key={provider.id}>
          <div className={styles.providerTitle}><h3>{provider.name}</h3><span>Torznab · {provider.mediaTypes.join(" · ")}</span></div>
          <p>{!provider.enabled ? "Disabled" : !provider.active ? "Excluded by provider override" : health[provider.id]?.status === "connected" ? "Connected" : health[provider.id]?.status === "unavailable" ? "Unavailable" : "Checking…"}</p>
          {canEdit ? <div className={styles.sourceActions}>
            <button type="button" className={styles.testButton} disabled={busy} onClick={() => { setDraft({ ...provider, apiKey: "" }); setMessage(""); setError(""); }}>Edit</button>
            <button type="button" className={styles.testButton} disabled={busy} onClick={() => act("update", { id: provider.id, enabled: !provider.enabled })}>{provider.enabled ? "Disable" : "Enable"}</button>
            <button type="button" className={styles.testButton} disabled={busy} onClick={() => { if (window.confirm(`Remove ${provider.name}?`)) void act("remove", { id: provider.id }); }}>Remove</button>
          </div> : null}
        </article>
      ))}
      {error ? <div className="notice error" role="alert">{error}</div> : null}
      {message ? <div className="notice" role="status">{message}</div> : null}
      {activeDraft && canEdit ? <form className={styles.providerCard} onSubmit={(event) => { event.preventDefault(); void act(activeDraft.id ? "update" : "create", activeDraft); }}>
        <h3>{activeDraft.id ? "Edit Torznab provider" : "Add Custom Indexer"}</h3>
        <div className={styles.providerForm}>
          {[["name", "Display name", "text"], ["endpoint", "Full Torznab API endpoint", "url"], ["apiKey", "API key (optional)", "password"]].map(([id, label, type]) => (
            <div className={styles.field} key={id}>
              <label htmlFor={`custom-${id}`}>{label}</label>
              <div className={styles.inputRow}><input id={`custom-${id}`} type={type} required={id !== "apiKey"} disabled={busy} value={activeDraft[id] || ""} autoComplete={id === "apiKey" ? "new-password" : "off"} placeholder={id === "apiKey" && activeDraft.apiKeyConfigured ? "Leave blank to keep existing key" : ""} onChange={(event) => setDraft({ ...activeDraft, [id]: event.target.value })} /></div>
            </div>
          ))}
          {activeDraft.apiKeyConfigured ? <label><input type="checkbox" checked={Boolean(activeDraft.clearApiKey)} disabled={busy} onChange={(event) => setDraft({ ...activeDraft, clearApiKey: event.target.checked })} /> Remove stored API key</label> : null}
          <label><input type="checkbox" checked={activeDraft.enabled} disabled={busy} onChange={(event) => setDraft({ ...activeDraft, enabled: event.target.checked })} /> Enabled</label>
          <p className={styles.sectionNote}>Use the API URL supplied by your indexer, without query parameters. Connection changes must pass verification before saving.</p>
          <div className={styles.sourceActions}>
            <button className={styles.testButton} type="button" disabled={busy} onClick={() => act("test", activeDraft)}>Test connection</button>
            <button className={styles.saveButton} type="submit" disabled={busy}>{busy ? "Working…" : "Verify and save"}</button>
            <button className={styles.testButton} type="button" disabled={busy} onClick={() => { setDraft(null); onAddClosed?.(); }}>Cancel</button>
          </div>
        </div>
      </form> : null}
      <div className={styles.sourceActions}>
        <button type="button" className={styles.testButton} disabled={busy || !providers.length} onClick={() => refresh(true)}>Refresh custom providers</button>
      </div>
    </div>
  );
}
