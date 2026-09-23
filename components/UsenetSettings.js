"use client";

import { useEffect, useState } from "react";
import styles from "./UsenetSettings.module.css";

async function request(url, options) {
  const response = await fetch(url, { cache: "no-store", ...options });
  const value = await response.json().catch(() => null);
  if (!response.ok) throw new Error(value?.error || "Usenet request failed.");
  return value;
}

export default function UsenetSettings() {
  const [config, setConfig] = useState(null);
  const [draft, setDraft] = useState({ name: "", endpoint: "", apiKey: "" });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  useEffect(() => { void request("/api/settings/usenet")
    .then(setConfig).catch((error) => setNotice(error.message)); }, []);

  async function act(work) {
    setBusy(true); setNotice("");
    try { await work(); }
    catch (error) { setNotice(error.message); }
    finally { setBusy(false); }
  }

  if (!config) return <p>Loading optional Usenet settings…</p>;
  return <div className={styles.card}>
    <h3>Usenet</h3>
    <p>Optional: search NZBs through your Newznab indexers and prepare media with TorBox. Your TorBox account needs Usenet support.</p>
    <p>TorBox Usenet: <strong>{config.capability}</strong></p>
    <label className={styles.toggle}><input type="checkbox" checked={config.enabled} disabled={!config.canEdit || busy}
      onChange={(event) => void act(async () => {
        const next = await request("/api/settings/usenet", { method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: event.target.checked }) });
        setConfig({ ...config, ...next });
      })} /> Enable Usenet results and NZB upload</label>
    <h4>Newznab indexers</h4>
    {config.indexers.map((indexer) => <div className={styles.indexer} key={indexer.id}>
      <span>{indexer.name} · API key configured</span>{" "}
      <button type="button" disabled={!config.canEdit || busy} onClick={() => void act(async () => {
        await request(`/api/settings/usenet/indexers/${indexer.id}`, { method: "POST",
          headers: { "Content-Type": "application/json" }, body: "{}" });
        setNotice(`${indexer.name} connected.`);
      })}>Test</button>{" "}
      <button type="button" disabled={!config.canEdit || busy} onClick={() => void act(async () => {
        const next = await request(`/api/settings/usenet/indexers/${indexer.id}`, { method: "DELETE",
          headers: { "Content-Type": "application/json" }, body: "{}" });
        setConfig({ ...config, ...next });
      })}>Remove</button>
    </div>)}
    <form className={styles.form} onSubmit={(event) => { event.preventDefault(); void act(async () => {
      const next = await request("/api/settings/usenet/indexers", { method: "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft) });
      setConfig({ ...config, ...next });
      setDraft({ name: "", endpoint: "", apiKey: "" });
      setNotice("Newznab indexer connected.");
    }); }}>
      <label>Name <input value={draft.name} maxLength={80} disabled={!config.canEdit || busy}
        onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
      <label>Newznab URL <input type="url" value={draft.endpoint} disabled={!config.canEdit || busy}
        placeholder="https://indexer.example/api"
        onChange={(event) => setDraft({ ...draft, endpoint: event.target.value })} /></label>
      <label>API key <input type="password" autoComplete="off" value={draft.apiKey}
        disabled={!config.canEdit || busy}
        onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })} /></label>
      <button type="submit" disabled={!config.canEdit || busy}>Test and add indexer</button>
    </form>
    {notice ? <p role="status">{notice}</p> : null}
  </div>;
}
