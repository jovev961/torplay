"use client";

import { useState } from "react";
import { sourceRequest } from "./source-request.js";
import styles from "./SettingsManager.module.css";

export default function CommunitySources({ busy, onSelect, onAdvanced }) {
  const [directory, setDirectory] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  async function browse(refresh = false) {
    setLoading(true); setError("");
    try { setDirectory(await sourceRequest("list-community-definitions", undefined, refresh)); }
    catch (error) { setError(error.message); }
    finally { setLoading(false); }
  }
  const entries = directory?.entries.filter((entry) => `${entry.name} ${entry.id}`.toLowerCase().includes(query.trim().toLowerCase())) || [];
  return (
    <section className={styles.providerForm}>
      <p>Choose a third-party source to find videos. Availability varies. TorPlay checks compatibility when you select a source.</p>
      <p>The community list is loaded from Prowlarr on GitHub only when you choose Browse.</p>
      <div className={styles.sourceActions}>
        <button className={styles.saveButton} disabled={loading || busy} type="button" onClick={() => void browse(Boolean(directory))}>{loading ? "Loading sources…" : directory ? "Refresh list" : "Browse community sources"}</button>
        <button className={styles.testButton} disabled={loading || busy} type="button" onClick={onAdvanced}>Advanced setup</button>
      </div>
      {error ? <div className="notice error" role="alert">{error} <button type="button" disabled={loading || busy} onClick={() => void browse(true)}>Retry</button></div> : null}
      {directory ? <>
        <label className={styles.field}>Search sources<input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Source name" /></label>
        <p role="status">{entries.length} sources · Names come from community filenames. Select one to see its details.</p>
        <ul className={styles.communityList}>
          {entries.map((entry) => <li key={entry.id}><button type="button" className={styles.testButton} disabled={busy || loading} onClick={() => onSelect(entry.id, directory.revision)}>{entry.name}</button></li>)}
        </ul>
        {!entries.length ? <p>No sources match your search.</p> : null}
      </> : null}
    </section>
  );
}
