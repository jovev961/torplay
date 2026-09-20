"use client";

import { useEffect, useState } from "react";
import styles from "./SettingsManager.module.css";

const statusLabels = {
  available: "Available",
  unavailable: "Unavailable",
  connected: "Available",
  disabled: "Disabled",
  checking: "Checking…",
};

const PROWLARR_DEFINITIONS_URL = "https://github.com/Prowlarr/Indexers/tree/master/definitions/v11";

function accessLabel(value) {
  return String(value || "").split("-").map((part) => part ? `${part[0].toUpperCase()}${part.slice(1)}` : "").join("-");
}

function languageLabel(value) {
  const code = String(value || "");
  if (!code) return "Unknown";
  try {
    return `${new Intl.DisplayNames(["en"], { type: "language" }).of(code) || code} (${code})`;
  } catch {
    return code;
  }
}

async function request(action, provider, refresh = false, extra = {}) {
  const response = await fetch("/api/settings/torrent-providers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, provider, refresh, ...extra }),
  });
  const body = await response.json();
  if (!response.ok) {
    const details = body.unsupportedFeatures?.map((item) => item.message).join(" ");
    throw new Error([body.error || "Provider request failed.", details].filter(Boolean).join(" "));
  }
  return body;
}

function mediaLabel(mediaTypes) {
  return mediaTypes.map((type) => type === "TV" ? "TV Shows" : type).join(" & ");
}

function IndexerStatus({ status, message }) {
  const statusClass = status === "connected" ? "available" : status;
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
  const [definitionUrl, setDefinitionUrl] = useState("");
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
    setDefinitionUrl("");
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
      if (action === "test") {
        setMessage(`Connected · ${data.capabilities.mediaTypes.join(" · ")}`);
      } else {
        setCustomProviders(data.providers);
        setDraft(null);
        setImportDraft(null);
        setDialogOpen(false);
        setMessage(action === "remove" ? "Indexer removed." : "Indexer saved.");
        await onCustomChanged();
        await refreshCustom(true);
      }
    } catch (actionError) {
      setError(actionError.message);
    } finally {
      setBusy(false);
    }
  }

  async function importDefinition() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const data = await request("import-definition", undefined, false, { definitionUrl });
      setImportDraft({
        ...data,
        enabled: true,
        values: Object.fromEntries(data.definition.settings.map((field) => [field.name, field.default ?? (field.type === "checkbox" ? false : "")])),
      });
    } catch (importError) {
      setError(importError.message);
    } finally {
      setBusy(false);
    }
  }

  async function saveImported() {
    await act("create-cardigann", { importId: importDraft.importId, settings: importDraft.values, enabled: importDraft.enabled });
  }

  const configuredCount = customProviders.length;

  return (
    <div className={styles.indexerManager}>
      <div className={styles.indexerHeading}>
        <div>
          <h3>Configured Indexers</h3>
          <p>All imported Cardigann and Torznab-compatible sources you have added.</p>
        </div>
        {canEdit ? (
          <button className={styles.saveButton} type="button" onClick={() => setDialogOpen(true)}>
            + Add Indexer
          </button>
        ) : null}
      </div>

      {configuredCount ? (
        <div className={styles.sourceGrid}>
          {customProviders.map((provider) => {
            const currentHealth = health[provider.id];
            const status = !provider.enabled || !provider.active
              ? "disabled"
              : currentHealth?.status || "checking";
            const statusMessage = !provider.enabled
              ? "Source is disabled."
              : !provider.active
                ? "Source is excluded by the provider override."
                : currentHealth?.message || "Checking source availability.";
            return (
              <article className={styles.sourceCard} key={provider.id}>
                <div className={styles.sourceCardHeading}>
                  <span><strong>{provider.name}</strong><small>{provider.type} · {mediaLabel(provider.mediaTypes)}</small></span>
                  {canEdit ? (
                    <div className={styles.sourceCardActions}>
                      <button className={styles.testButton} type="button" disabled={busy} onClick={() => {
                        if (provider.kind === "cardigann") {
                          setImportDraft({ editId: provider.id, definition: { name: provider.name, settings: provider.settings }, enabled: provider.enabled, values: Object.fromEntries(provider.settings.map((field) => [field.name, field.value ?? (field.type === "checkbox" ? false : "")])) });
                        } else setDraft({ ...provider, apiKey: "" });
                        setDialogOpen(true); setMessage(""); setError("");
                      }}>Edit</button>
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
          <strong>No indexers configured yet.</strong>
          <p>TorPlay does not include torrent indexers.<br />Add a compatible third-party source to enable torrent search.</p>
          {canEdit ? <button className={styles.saveButton} type="button" onClick={() => setDialogOpen(true)}>+ Add Indexer</button> : null}
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

      {dialogOpen ? (
        <div className={styles.dialogBackdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeDialog(); }}>
          <div className={styles.indexerDialog} role="dialog" aria-modal="true" aria-labelledby="indexer-dialog-title">
            <div className={styles.dialogHeading}>
              <div>
                <span className="eyebrow">Torrent Sources</span>
                <h2 id="indexer-dialog-title">{draft?.id || importDraft?.editId ? "Edit Indexer" : draft ? "Add Custom Indexer" : importDraft ? "Import Indexer" : "Add Indexer"}</h2>
              </div>
              <button className={styles.dialogClose} type="button" aria-label="Close Add Indexer" disabled={busy} onClick={closeDialog}>×</button>
            </div>

            {error ? <div className="notice error" role="alert">{error}</div> : null}
            {message ? <div className="notice success" role="status">{message}</div> : null}

            {importDraft ? (
              <form onSubmit={(event) => { event.preventDefault(); void (importDraft.editId
                ? act("update-cardigann", { id: importDraft.editId, settings: importDraft.values, enabled: importDraft.enabled })
                : saveImported()); }}>
                <div className={styles.definitionPreview}>
                  <h3>Definition preview</h3>
                  <dl className={styles.definitionDetails}>
                    <div><dt>Name</dt><dd>{importDraft.definition.name}</dd></div>
                    {importDraft.definition.access ? <div><dt>Access</dt><dd>{accessLabel(importDraft.definition.access)}</dd></div> : null}
                    {importDraft.definition.language ? <div><dt>Language</dt><dd>{languageLabel(importDraft.definition.language)}</dd></div> : null}
                    {importDraft.definition.mediaTypes?.length ? <div><dt>Categories</dt><dd>{importDraft.definition.mediaTypes.join(", ")}</dd></div> : null}
                    {importDraft.definition.website ? <div><dt>Website</dt><dd className={styles.definitionUrl}>{importDraft.definition.website}</dd></div> : null}
                    {importDraft.definition.sourceUrl ? <div><dt>Definition</dt><dd className={styles.definitionUrl}>{importDraft.definition.sourceUrl}</dd></div> : null}
                  </dl>
                  {importDraft.definition.settings.length ? (
                    <p className={styles.definitionRequirement}>Configuration is required. Complete the fields below before adding this indexer.</p>
                  ) : (
                    <p className={`${styles.definitionRequirement} ${styles.definitionReady}`}>✓ No account configuration required</p>
                  )}
                </div>
                <div className={styles.providerForm}>
                  {importDraft.definition.settings.length ? <h3>Configuration required</h3> : null}
                  {importDraft.definition.settings.map((field) => (
                    <div className={styles.field} key={field.name}>
                      <label htmlFor={`cardigann-${field.name}`}>{field.label}</label>
                      {field.type === "checkbox" ? (
                        <label className={styles.checkboxLabel}><input id={`cardigann-${field.name}`} type="checkbox" checked={Boolean(importDraft.values[field.name])} disabled={busy} onChange={(event) => setImportDraft({ ...importDraft, values: { ...importDraft.values, [field.name]: event.target.checked } })} /> Enabled</label>
                      ) : field.type === "select" ? (
                        <select id={`cardigann-${field.name}`} required={field.required} disabled={busy} value={importDraft.values[field.name] || ""} onChange={(event) => setImportDraft({ ...importDraft, values: { ...importDraft.values, [field.name]: event.target.value } })}>
                          {!field.required ? <option value="">Default</option> : null}
                          {Object.entries(field.options || {}).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
                        </select>
                      ) : (
                        <div className={styles.inputRow}><input id={`cardigann-${field.name}`} type={field.secret ? "password" : "text"} required={field.required && !field.configured} disabled={busy} value={importDraft.values[field.name] || ""} placeholder={field.configured ? "Leave blank to keep existing value" : ""} autoComplete={field.secret ? "new-password" : "off"} onChange={(event) => setImportDraft({ ...importDraft, values: { ...importDraft.values, [field.name]: event.target.value } })} /></div>
                      )}
                    </div>
                  ))}
                  <label className={styles.checkboxLabel}><input type="checkbox" checked={importDraft.enabled} disabled={busy} onChange={(event) => setImportDraft({ ...importDraft, enabled: event.target.checked })} /> Enabled</label>
                  <div className={styles.sourceActions}>
                    <button className={styles.saveButton} type="submit" disabled={busy}>{busy ? "Verifying…" : importDraft.editId ? "Verify and save" : "Add Indexer"}</button>
                    <button className={styles.testButton} type="button" disabled={busy} onClick={() => importDraft.editId ? closeDialog() : setImportDraft(null)}>Cancel</button>
                  </div>
                </div>
              </form>
            ) : draft ? (
              <form onSubmit={(event) => { event.preventDefault(); void act(draft.id ? "update" : "create", draft); }}>
                <p className={styles.dialogIntro}>Add a Torznab-compatible source such as your own Prowlarr or Jackett configuration.</p>
                <div className={styles.providerForm}>
                  {[["name", "Display name", "text"], ["endpoint", "Full Torznab API endpoint", "url"], ["apiKey", "API key (optional)", "password"]].map(([id, label, type]) => (
                    <div className={styles.field} key={id}>
                      <label htmlFor={`custom-${id}`}>{label}</label>
                      <div className={styles.inputRow}>
                        <input id={`custom-${id}`} type={type} required={id !== "apiKey"} disabled={busy} value={draft[id] || ""} autoComplete={id === "apiKey" ? "new-password" : "off"} placeholder={id === "apiKey" && draft.apiKeyConfigured ? "Leave blank to keep existing key" : ""} onChange={(event) => setDraft({ ...draft, [id]: event.target.value })} />
                      </div>
                    </div>
                  ))}
                  {draft.apiKeyConfigured ? <label className={styles.checkboxLabel}><input type="checkbox" checked={Boolean(draft.clearApiKey)} disabled={busy} onChange={(event) => setDraft({ ...draft, clearApiKey: event.target.checked })} /> Remove stored API key</label> : null}
                  <label className={styles.checkboxLabel}><input type="checkbox" checked={draft.enabled} disabled={busy} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} /> Enabled</label>
                  <p className={styles.sectionNote}>Use the API URL supplied by your indexer, without query parameters. Connection changes must pass verification before saving.</p>
                  <div className={styles.sourceActions}>
                    <button className={styles.testButton} type="button" disabled={busy} onClick={() => void act("test", draft)}>Test connection</button>
                    <button className={styles.saveButton} type="submit" disabled={busy}>{busy ? "Working…" : "Verify and save"}</button>
                    <button className={styles.testButton} type="button" disabled={busy} onClick={() => draft.id ? closeDialog() : setDraft(null)}>Back</button>
                  </div>
                </div>
              </form>
            ) : (
              <div className={styles.addIndexerOptions}>
                <section className={styles.customIndexerOption}>
                  <h3>Custom Indexer</h3>
                  <p>Add a Torznab-compatible source such as your own Prowlarr or Jackett configuration.</p>
                  <button className={styles.testButton} type="button" onClick={() => setDraft({ name: "", endpoint: "", apiKey: "", enabled: true })}>+ Add Custom Indexer</button>
                </section>
                <section className={styles.customIndexerOption}>
                  <h3>Import Indexer Definition</h3>
                  <p>Paste a public HTTPS Cardigann v11 YAML definition URL or a normal GitHub definition-file page.</p>
                  <div className={styles.providerForm}>
                    <div className={styles.field}>
                      <label htmlFor="cardigann-definition-url">Definition URL</label>
                      <div className={styles.inputRow}>
                        <input id="cardigann-definition-url" type="url" required disabled={busy} value={definitionUrl} placeholder="https://github.com/.../example.yml" onChange={(event) => setDefinitionUrl(event.target.value)} />
                        <button className={styles.testButton} type="button" disabled={busy || !definitionUrl.trim()} onClick={() => void importDefinition()}>{busy ? "Importing…" : "Import"}</button>
                      </div>
                    </div>
                    <aside className={styles.definitionHelp} aria-labelledby="definition-help-title">
                      <strong id="definition-help-title">Don&apos;t know where to find a definition?</strong>
                      <p>Browse community-maintained definitions in the Prowlarr Indexers repository.</p>
                      <strong>How to add one:</strong>
                      <ol>
                        <li>Open the definitions list.</li>
                        <li>Find the indexer you want.</li>
                        <li>Open its <code>.yml</code> file.</li>
                        <li>Copy the URL of that file from your browser.</li>
                        <li>Paste the URL above and select <strong>Import</strong>.</li>
                      </ol>
                      <p>You do not need to use GitHub&apos;s <strong>Raw</strong> button. TorPlay accepts normal GitHub file URLs.</p>
                      <a className={styles.definitionBrowse} href={PROWLARR_DEFINITIONS_URL} target="_blank" rel="noreferrer">Browse Prowlarr Indexer Definitions ↗</a>
                      <div className={styles.definitionExample}>
                        <strong>✓ Use the URL of the definition file:</strong>
                        <code>https://github.com/Prowlarr/Indexers/blob/master/definitions/v11/example.yml</code>
                        <span>Do not paste the torrent indexer&apos;s website URL.</span>
                      </div>
                    </aside>
                  </div>
                </section>
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
