"use client";

import { useEffect, useRef, useState } from "react";
import AddSourceDialog from "./AddSourceDialog.js";
import { sourceRequest as request } from "./source-request.js";
import { readNdjson } from "./readNdjson.js";
import { useI18n } from "./I18nProvider.js";
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

function SourceBadges({ provider }) {
  const access = ({ public: "Public", "semi-private": "Semi-public", private: "Private" })[provider.access];
  return <div className={styles.sourceBadges}>
    {provider.mediaTypes.map((type) => <span className={styles.sourceBadge} key={type}>{type === "TV" ? "TV / Series" : type}</span>)}
    {access ? <span className={`${styles.sourceBadge} ${provider.access === "public" ? styles.publicBadge : provider.access === "private" ? styles.privateBadge : styles.semiBadge}`}>{access}</span> : null}
    {provider.requiresFlareSolverr ? <span className={styles.sourceBadge}>FlareSolverr</span> : null}
  </div>;
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

async function requestHealth(refresh, signal, onEvent) {
  const response = await fetch("/api/settings/torrent-providers", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
    body: JSON.stringify({ action: "health", refresh }), signal,
  });
  await readNdjson(response, onEvent);
}

export default function TorrentIndexerManager({
  nativeSources = [],
  initialCustomProviders,
  canEdit,
  onCustomChanged,
}) {
  const { t } = useI18n();
  const [customProviders, setCustomProviders] = useState(initialCustomProviders);
  const [health, setHealth] = useState({});
  const [dialogOpen, setDialogOpen] = useState(false);
  const [draft, setDraft] = useState(null);
  const [importDraft, setImportDraft] = useState(null);
  const [jackettDraft, setJackettDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [testingId, setTestingId] = useState(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [pendingRemoval, setPendingRemoval] = useState(null);
  const healthController = useRef(null);
  const handleHealthEvent = (event) => {
    if (event.type === "status") setHealth((current) => ({ ...current,
      [event.result.provider]: { ...event.result, stale: event.stale === true } }));
    if (event.type === "error") setError(event.error);
  };

  async function refreshCustom(force = false) {
    healthController.current?.abort();
    const controller = new AbortController();
    healthController.current = controller;
    try {
      await requestHealth(force, controller.signal, handleHealthEvent);
    } catch (refreshError) {
      if (refreshError.name !== "AbortError") setError(refreshError.message);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    healthController.current = controller;
    void requestHealth(false, controller.signal, (event) => {
      if (event.type === "status") setHealth((current) => ({ ...current,
        [event.result.provider]: { ...event.result, stale: event.stale === true } }));
      if (event.type === "error") setError(event.error);
    }).catch((loadError) => {
      if (loadError.name !== "AbortError") setError(loadError.message);
    });
    return () => controller.abort();
  }, []);

  function closeDialog() {
    if (busy) return;
    setDialogOpen(false);
    setDraft(null);
    setImportDraft(null);
    setJackettDraft(null);
    setMessage("");
    setError("");
  }

  async function act(action, provider) {
    setBusy(true);
    if (action === "test-cardigann") setTestingId(provider.id);
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
        if (Array.isArray(data.providers)) setCustomProviders(data.providers);
        setDraft(null);
        setImportDraft(null);
        setDialogOpen(false);
        setMessage(action.startsWith("remove") ? "Source removed." : "Source saved.");
        const snapshot = await onCustomChanged();
        if (Array.isArray(snapshot?.customProviders)) setCustomProviders(snapshot.customProviders);
        await refreshCustom(true);
      }
    } catch (actionError) {
      setError(actionError.message);
    } finally {
      setBusy(false);
      setTestingId(null);
    }
  }

  const configuredNative = nativeSources.filter((source) => source.configured);
  const configuredCount = configuredNative.length + customProviders.length;

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
          {configuredNative.map((provider) => {
            const currentHealth = health[provider.id];
            const status = !provider.enabled || !provider.active
              ? "disabled"
              : currentHealth?.status || "checking";
            const statusMessage = !provider.enabled
              ? "Source is disabled."
              : !provider.active
                ? "Source is excluded by the provider override."
                : currentHealth?.stale ? `${currentHealth.message} Refreshing…`
                  : currentHealth?.message || "Checking source availability.";
            return (
              <article className={styles.sourceCard} key={provider.id}>
                <div className={styles.sourceCardHeading}>
                  <span className={styles.sourceKicker}>TorPlay tested source</span>
                  <strong>{provider.name}</strong>
                </div>
                <SourceBadges provider={provider} />
                <p>{provider.description}</p>
                <IndexerStatus status={status} message={statusMessage} />
                {canEdit ? <div className={styles.sourceCardActions}>
                  <button className={styles.testButton} type="button" disabled={busy} onClick={() => void act("update-native", { id: provider.id, enabled: !provider.enabled })}>{provider.enabled ? "Disable" : "Enable"}</button>
                  <button className={styles.removeButton} type="button" disabled={busy} onClick={() => setPendingRemoval({ action: "remove-native", provider })}>Remove</button>
                </div> : null}
              </article>
            );
          })}
          {customProviders.map((provider) => {
            const currentHealth = health[provider.id];
            const status = !provider.enabled || !provider.active
              ? "disabled"
              : currentHealth?.status || provider.verification?.status || "checking";
            const statusMessage = !provider.enabled
              ? "Source is disabled."
              : !provider.active
                ? "Source is excluded by the provider override."
                : currentHealth?.stale ? `${currentHealth.message} Refreshing…`
                  : currentHealth?.message || (provider.verification?.message
                    ? `Last verification: ${provider.verification.message}` : "Checking source availability.");
            return (
              <article className={styles.sourceCard} key={provider.id}>
                <div className={styles.sourceCardHeading}>
                  <span className={styles.sourceKicker}>{provider.type}</span>
                  <strong>{provider.name}</strong>
                </div>
                <SourceBadges provider={provider} />
                <p>{provider.kind === "cardigann" ? "Imported Cardigann definition." : provider.kind === "jackett" ? "External Jackett indexer." : "Custom Torznab-compatible indexer."}</p>
                <IndexerStatus status={status} message={statusMessage} />
                {canEdit ? <div className={styles.sourceCardActions}>
                      <button className={styles.testButton} type="button" disabled={busy} onClick={() => {
                        if (provider.kind === "cardigann") {
                          setImportDraft({ editId: provider.id, definition: { name: provider.name, categories: provider.categories, settings: provider.settings }, enabled: provider.enabled, values: settingValues(provider.settings) });
                        } else if (provider.kind === "jackett") setJackettDraft(provider);
                        else setDraft({ ...provider, apiKey: "" });
                        setDialogOpen(true); setMessage(""); setError("");
                      }}>Edit</button>
                      {provider.kind === "cardigann" ? <button className={styles.testButton} type="button" disabled={busy} onClick={() => void act("test-cardigann", { id: provider.id })}>{testingId === provider.id ? "Testing…" : "Test"}</button> : null}
                      <button className={styles.testButton} type="button" disabled={busy} onClick={() => void act(provider.kind === "cardigann" ? "update-cardigann" : provider.kind === "jackett" ? "update-jackett" : "update", { id: provider.id, enabled: !provider.enabled, mediaTypes: provider.mediaTypes })}>{provider.enabled ? "Disable" : "Enable"}</button>
                      <button className={styles.removeButton} type="button" disabled={busy} onClick={() => setPendingRemoval({ action: provider.kind === "cardigann" ? "remove-cardigann" : "remove", provider })}>Remove</button>
                </div> : null}
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
        initial={{ draft, importDraft, jackettDraft }}
        testedSources={nativeSources}
        configuredProviders={customProviders}
        onClose={closeDialog}
        onSaved={async (data) => {
          if (Array.isArray(data.providers)) setCustomProviders(data.providers);
          closeDialog(); setMessage("Source saved.");
          setHealth({});
          const snapshot = await onCustomChanged();
          if (Array.isArray(snapshot?.customProviders)) setCustomProviders(snapshot.customProviders);
        }}
      /> : null}

      {pendingRemoval ? (
        <div className={styles.dialogBackdrop} onMouseDown={(event) => {
          if (!busy && event.target === event.currentTarget) setPendingRemoval(null);
        }}>
          <div className={styles.indexerDialog} role="dialog" aria-modal="true" aria-labelledby="remove-source-title">
            <div className={styles.dialogHeading}>
              <h2 id="remove-source-title">{t("Remove source")}</h2>
              <button className={styles.dialogClose} type="button" aria-label={t("Cancel")} disabled={busy} onClick={() => setPendingRemoval(null)}>×</button>
            </div>
            <p className={styles.dialogIntro}>{t("Remove {name}?", { name: pendingRemoval.provider.name })}</p>
            <div className={styles.sourceActions}>
              <button className={styles.testButton} type="button" disabled={busy} onClick={() => setPendingRemoval(null)}>{t("Cancel")}</button>
              <button className={styles.removeButton} type="button" disabled={busy} onClick={() => {
                const removal = pendingRemoval;
                setPendingRemoval(null);
                void act(removal.action, { id: removal.provider.id });
              }}>{t("Remove")}</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
