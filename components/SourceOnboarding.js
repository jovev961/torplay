"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import AddSourceDialog from "./AddSourceDialog.js";
import styles from "./SettingsManager.module.css";

export default function SourceOnboarding() {
  const [snapshot, setSnapshot] = useState(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  async function load() {
    const response = await fetch("/api/settings", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Source settings could not be loaded.");
    return data;
  }
  useEffect(() => {
    let cancelled = false;
    load().then((data) => { if (!cancelled) setSnapshot(data); }).catch((error) => { if (!cancelled) setError(error.message); });
    return () => { cancelled = true; };
  }, []);
  const active = snapshot?.torrentSources.nativeActive
    || snapshot?.torrentSources.customActive;
  return <>
    {error ? <p className="notice error" role="alert">{error}</p> : null}
    {!snapshot && !error ? <p>Loading source settings…</p> : null}
    {snapshot && !snapshot.canEdit ? <p>Source setup is available on your private local network.</p> : null}
    {active ? <p className="notice" role="status">You already have an enabled source. You can continue to the catalog or add another.</p> : null}
    {saved ? <div className="notice" role="status">
      <p>Source saved. Availability and verification status are shown in Settings.</p>
      <button className={styles.testButton} type="button" onClick={() => setSaved(false)}>Add another source</button>
    </div> : snapshot?.canEdit ? <AddSourceDialog embedded testedSources={snapshot.nativeSources} configuredProviders={snapshot.customProviders} onSaved={async () => {
      setSaved(true);
      try { setSnapshot(await load()); } catch (error) { setError(error.message); }
    }} /> : null}
    <div className={styles.sourceActions}>
      <Link className={styles.saveButton} href="/">{active || saved ? "Continue to catalog" : "Skip for now"}</Link>
      <Link className={styles.testButton} href="/settings#torrent-sources">Manage sources in Settings</Link>
    </div>
  </>;
}
