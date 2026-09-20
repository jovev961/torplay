"use client";

import { useEffect, useState } from "react";
import AddSourceDialog from "./AddSourceDialog.js";
import { sourceRequest as request } from "./source-request.js";
import styles from "./SettingsManager.module.css";

const statusLabels = {
  available: "Available",
  unavailable: "Unavailable",
  unverified: "Unverified",
  verified: "Verified",
  connected: "Available",
  disabled: "Disabled",
  checking: "Checking…",
};

function mediaLabel(mediaTypes) {
  return mediaTypes.map((type) => type === "TV" ? "TV Shows" : type).join(" & ");
}

function settingValues(settings) {
  return Object.fromEntries(settings.filter((field) => !field.informational)
    .map((field) => [field.name, field.value ?? field.default ?? (field.type === "checkbox" ? false : "")]));
}

function IndexerStatus({ status, message }) {
  const statusClass = ["connected", "verified"].includes(status) ? "available" : status;
  return (
    <div className={styles.providerStatus}>
      <span className={`${styles.statusBadge} ${styles[statusClass] || ""}`}>
        {statusLabels[status] || "Unknown"}
      </span>
      <span>{message}</span>
    </div>
  );
}

export default function TorrentIndexerManager({
  initialCustomProviders,
  canEdit,
  onCustomChanged,
}) {
  const [customProviders, setCustomProviders] = useState(initialCustomProviders);
  const [health, setHealth] = useState({});
  const [dialogOpen, setDialogOpen] = useState(false);
  const [draft, setDraft] = useState(null);
  const [importDraft, setImportDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function refreshCustom(force = false) {
    try {
      const data = await request("health", undefined, force);
      setHealth(Object.fromEntries(data.results.map((item) => [item.provider, item])));
    } catch (refreshError) {
      setError(refreshError.message);
    }
  }

  useEffect(() => {
    let cancelled = false;
    request("health").then((data) => {
      if (!cancelled) setHealth(Object.fromEntries(data.results.map((item) => [item.provider, item])));
    }).catch((loadError) => {
      if (!cancelled) setError(loadError.message);
    });
    return () => { cancelled = true; };
  }, []);

  function closeDialog() {
    if (busy) return;
    setDialogOpen(false);
    setDraft(null);
    setImportDraft(null);
    setMessage("");
    setError("");
  }

  async function act(action, provider) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const data = await request(action, provider);
      if (action === "test-cardigann") {
        setCustomProviders(data.providers);
        setHealth((current) => ({
          ...current,
          [provider.id]: {
            provider: provider.id,
            status: data.verification.status === "verified" ? "connected" : "unavailable",
            message: data.verification.message,
            checkedAt: data.verification.checkedAt,
          },
        }));
        setMessage(data.verification.status === "verified" ? "Indexer connection verified." : data.verification.message);
        await onCustomChanged();
      } else {
        setCustomProviders(data.providers);
        setDraft(null);
        setImportDraft(null);
        setDialogOpen(false);
        setMessage(action.startsWith("remove") ? "Source removed." : "Source saved.");
        await onCustomChanged();
        await refreshCustom(true);
      }
    } catch (actionError) {
      setError(actionError.message);
    } finally {
      setBusy(false);
    }
  }

  const configuredCount = customProviders.length;

  return (
    <div className={styles.indexerManager}>
      <div className={styles.indexerHeading}>
        <div>
          <h3>Configured sources</h3>
          <p>Manage the sources you have added for movie and TV searches.</p>
        </div>
        {canEdit ? (
          <button className={styles.saveButton} type="button" onClick={() => setDialogOpen(true)}>
            + Add source
          </button>
        ) : null}
      </div>

      {configuredCount ? (
        <div className={styles.sourceGrid}>
          {customProviders.map((provider) => {
            const currentHealth = health[provider.id];
            const status = !provider.enabled || !provider.active
              ? "disabled"
              : currentHealth?.status || provider.verification?.status || "checking";
            const statusMessage = !provider.enabled
              ? "Source is disabled."
              : !provider.active
                ? "Source is excluded by the provider override."
                : currentHealth?.message || provider.verification?.message || "Checking source availability.";
            return (
              <article className={styles.sourceCard} key={provider.id}>
                <div className={styles.sourceCardHeading}>
                  <span><strong>{provider.name}</strong><small>{provider.type} · {mediaLabel(provider.mediaTypes)}</small></span>
                  {canEdit ? (
                    <div className={styles.sourceCardActions}>
                      <button className={styles.testButton} type="button" disabled={busy} onClick={() => {
                        if (provider.kind === "cardigann") {
                          setImportDraft({ editId: provider.id, definition: { name: provider.name, categories: provider.categories, settings: provider.settings }, enabled: provider.enabled, values: settingValues(provider.settings) });
                        } else setDraft({ ...provider, apiKey: "" });
                        setDialogOpen(true); setMessage(""); setError("");
                      }}>Edit</button>
                      {provider.kind === "cardigann" ? <button className={styles.testButton} type="button" disabled={busy} onClick={() => void act("test-cardigann", { id: provider.id })}>Test</button> : null}
                      <button className={styles.testButton} type="button" disabled={busy} onClick={() => void act(provider.kind === "cardigann" ? "update-cardigann" : "update", { id: provider.id, enabled: !provider.enabled })}>{provider.enabled ? "Disable" : "Enable"}</button>
                      <button className={styles.removeButton} type="button" disabled={busy} onClick={() => { if (window.confirm(`Remove ${provider.name}?`)) void act(provider.kind === "cardigann" ? "remove-cardigann" : "remove", { id: provider.id }); }}>Remove</button>
                    </div>
                  ) : null}
                </div>
                <p>{provider.kind === "cardigann" ? "Imported Cardigann definition." : "Custom Torznab-compatible indexer."}</p>
                <IndexerStatus status={status} message={statusMessage} />
              </article>
            );
          })}
        </div>
      ) : (
        <div className={styles.emptyState}>
          <strong>No sources configured yet.</strong>
          <p>Choose a community source or use advanced setup to enable torrent search.</p>
          {canEdit ? <button className={styles.saveButton} type="button" onClick={() => setDialogOpen(true)}>+ Add source</button> : null}
        </div>
      )}

      {!dialogOpen && error ? <div className="notice error" role="alert">{error}</div> : null}
      {!dialogOpen && message ? <div className="notice success" role="status">{message}</div> : null}

      {configuredCount ? (
        <div className={styles.sourceActions}>
          <button className={styles.testButton} type="button" disabled={busy} onClick={() => void refreshCustom(true)}>
            Refresh availability
          </button>
        </div>
      ) : null}

      {dialogOpen ? <AddSourceDialog
        initial={{ draft, importDraft }}
        onClose={closeDialog}
        onSaved={async (providers) => {
          setCustomProviders(providers); closeDialog(); setMessage("Source saved.");
          setHealth({});
          await onCustomChanged();
        }}
      /> : null}
    </div>
  );
}
