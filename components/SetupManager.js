"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import styles from "./SetupManager.module.css";

const statusLabels = { valid: "Verified", invalid: "Invalid", unreachable: "Unreachable", missing: "Missing" };

async function json(response) {
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(data?.error || "Setup request failed.");
    error.data = data;
    throw error;
  }
  return data;
}

export default function SetupManager() {
  const router = useRouter();
  const [snapshot, setSnapshot] = useState(null);
  const [values, setValues] = useState({});
  const [visible, setVisible] = useState({});
  const [results, setResults] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings", { cache: "no-store" })
      .then(json)
      .then((data) => {
        if (cancelled) return;
        setSnapshot(data);
        setValues(Object.fromEntries(data.providers.flatMap((provider) => provider.fields.flatMap((field) => (
          field.secret ? [] : [[`${provider.id}:${field.id}`, field.value || ""]]
        )))));
      })
      .catch((loadError) => { if (!cancelled) setError(loadError.message); });
    return () => { cancelled = true; };
  }, []);

  async function finish(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setResults({});
    const providers = {};
    for (const provider of snapshot.providers.filter((item) => item.required)) {
      providers[provider.id] = {};
      for (const field of provider.fields.filter((item) => item.required)) {
        const fieldKey = `${provider.id}:${field.id}`;
        if (!field.managedExternally && (field.secret ? values[fieldKey]?.trim() : values[fieldKey] !== field.value)) {
          if (values[fieldKey]?.trim()) providers[provider.id][field.id] = values[fieldKey];
        }
      }
    }
    try {
      const data = await json(await fetch("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providers }),
      }));
      setResults(Object.fromEntries(data.results.map((item) => [item.provider, item])));
      router.replace("/");
      router.refresh();
    } catch (setupError) {
      setError(setupError.message);
      if (setupError.data?.results) {
        setResults(Object.fromEntries(setupError.data.results.map((item) => [item.provider, item])));
      }
    } finally {
      setBusy(false);
    }
  }

  if (error && !snapshot) return <div className="notice error" role="alert">{error}</div>;
  if (!snapshot) return <div className="notice">Loading setup…</div>;
  if (!snapshot.canEdit) {
    return <div className="notice" role="status">Setup is available only through TorPlay on your private local network.</div>;
  }
  const providers = snapshot.providers.filter((provider) => provider.required);

  return (
    <form className={styles.setupForm} onSubmit={finish}>
      {error ? <div className="notice error" role="alert">{error}</div> : null}
      {providers.map((provider, index) => {
        const result = results[provider.id];
        return (
          <article className={styles.providerCard} key={provider.id}>
            <div className={styles.providerHeading}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <div><h2>{provider.name}</h2><p>{provider.description}</p></div>
            </div>
            <p className={styles.help}>{provider.helpText} <a href={provider.helpUrl} target="_blank" rel="noreferrer">Open instructions ↗</a></p>
            {provider.fields.filter((field) => field.required).map((field) => {
              const fieldKey = `${provider.id}:${field.id}`;
              return (
                <div className={styles.field} key={field.id}>
                  <label htmlFor={fieldKey}>{field.label}</label>
                  <div className={styles.inputRow}>
                    <input
                      id={fieldKey}
                      type={field.secret && !visible[fieldKey] ? "password" : "text"}
                      value={values[fieldKey] || ""}
                      placeholder={field.secret && field.configured ? "Already configured — leave blank to keep" : ""}
                      disabled={busy || field.managedExternally}
                      autoComplete={field.secret ? "new-password" : "off"}
                      required={!field.configured && !field.managedExternally}
                      onChange={(event) => setValues((current) => ({ ...current, [fieldKey]: event.target.value }))}
                    />
                    {field.secret ? <button type="button" disabled={busy} onClick={() => setVisible((current) => ({ ...current, [fieldKey]: !current[fieldKey] }))}>{visible[fieldKey] ? "Hide" : "Show"}</button> : null}
                  </div>
                  {field.managedExternally ? <small>Managed by the host environment.</small> : null}
                </div>
              );
            })}
            {result ? <div className={`${styles.result} ${styles[result.status] || ""}`}><strong>{statusLabels[result.status] || result.status}</strong><span>{result.message}</span></div> : null}
          </article>
        );
      })}
      <div className={styles.finishRow}>
        <p>TorPlay will verify TMDB and open the catalog. Built-in torrent sources are ready to use; optional sources can be added in Settings.</p>
        <button type="submit" disabled={busy}>{busy ? "Verifying connections…" : "Verify and finish"}</button>
      </div>
    </form>
  );
}
