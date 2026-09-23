"use client";
import { useEffect, useState } from "react";
import { sourceRequest as request } from "./source-request.js";
import CommunitySources from "./CommunitySources.js";
import styles from "./SettingsManager.module.css";
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

function settingValues(settings) {
  return Object.fromEntries(settings.filter((field) => !field.informational)
    .map((field) => [field.name, field.value ?? field.default ?? (field.type === "checkbox" ? false : "")]));
}


export default function AddSourceDialog({ initial = {}, testedSources = [], configuredProviders = [], onClose, onSaved, embedded = false }) {
  const [draft, setDraft] = useState(initial.draft || null);
  const [jackettDraft, setJackettDraft] = useState(initial.jackettDraft || null);
  const [jackettIndexers, setJackettIndexers] = useState(null);
  const [definitionUrl, setDefinitionUrl] = useState("");
  const [importDraft, setImportDraft] = useState(initial.importDraft || null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [advanced, setAdvanced] = useState(false);
  useEffect(() => {
    let cancelled = false;
    request("jackett-indexers").then((data) => {
      if (!cancelled) setJackettIndexers(data.indexers);
    }).catch(() => { if (!cancelled) setJackettIndexers(null); });
    return () => { cancelled = true; };
  }, []);
  async function chooseJackett(indexerId, previous = null) {
    setBusy(true); setError("");
    try {
      const data = await request("jackett-capabilities", { indexerId });
      setJackettDraft({ id: previous?.id, indexerId, enabled: previous?.enabled ?? true,
        supported: data.capabilities.mediaTypes,
        mediaTypes: previous?.mediaTypes || data.capabilities.mediaTypes });
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  useEffect(() => {
    if (!initial.jackettDraft) return;
    let cancelled = false;
    request("jackett-capabilities", { indexerId: initial.jackettDraft.indexerId }).then((data) => {
      if (!cancelled) setJackettDraft({ ...initial.jackettDraft, supported: data.capabilities.mediaTypes });
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [initial.jackettDraft]);
  function closeDialog() { if (!busy) onClose(); }
  async function act(action, provider) {
    setBusy(true); setError(""); setMessage("");
    try {
      const data = await request(action, provider);
      if (action === "test") setMessage("Connected · " + data.capabilities.mediaTypes.join(" · "));
      else await onSaved(data);
    } catch (error) {
      if (action === "create-cardigann" && error.canAddUnverified) {
        setImportDraft((current) => ({ ...current, verificationFailure: error.verificationFailure, confirmationToken: error.confirmationToken }));
      } else setError(error.message);
    } finally { setBusy(false); }
  }
  async function importDefinition(id, revision) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const data = id
        ? await request("import-community-definition", { id, revision })
        : await request("import-definition", undefined, false, { definitionUrl });
      setImportDraft({
        ...data,
        enabled: true,
        values: settingValues(data.definition.settings),
      });
    } catch (importError) {
      setError(importError.message);
    } finally {
      setBusy(false);
    }
  }

  async function saveImported(addUnverified = false) {
    await act("create-cardigann", {
      importId: importDraft.importId,
      settings: importDraft.values,
      enabled: importDraft.enabled,
      ...(addUnverified ? { addUnverified: true, confirmationToken: importDraft.confirmationToken } : {}),
    });
  }

  function updateImported(field, value) {
    setImportDraft((current) => ({
      ...current,
      [field]: value,
      verificationFailure: null,
      confirmationToken: null,
    }));
  }

  function updateImportedSetting(name, value) {
    setImportDraft((current) => ({
      ...current,
      values: { ...current.values, [name]: value },
      verificationFailure: null,
      confirmationToken: null,
    }));
  }


  return (

        <div className={embedded ? undefined : styles.dialogBackdrop} onMouseDown={(event) => { if (!embedded && event.target === event.currentTarget) closeDialog(); }}>
          <div className={embedded ? styles.sourceOnboarding : styles.indexerDialog} role={embedded ? "region" : "dialog"} aria-modal={embedded ? undefined : true} aria-labelledby="indexer-dialog-title">
            <div className={styles.dialogHeading}>
              <div>
                <span className="eyebrow">Torrent Sources</span>
                <h2 id="indexer-dialog-title">{draft?.id || importDraft?.editId || jackettDraft?.id ? "Edit source" : draft ? "Add Torznab source" : jackettDraft ? "Add Jackett source" : importDraft ? "Review source" : "Choose a source"}</h2>
              </div>
              {!embedded ? <button className={styles.dialogClose} type="button" aria-label="Close source setup" disabled={busy} onClick={closeDialog}>×</button> : null}
            </div>

            {error ? <div className="notice error" role="alert">{error}</div> : null}
            {message ? <div className="notice success" role="status">{message}</div> : null}

            {jackettDraft ? (
              <form onSubmit={(event) => { event.preventDefault(); void act(jackettDraft.id ? "update-jackett" : "create-jackett", jackettDraft); }}>
                <div className={styles.providerForm}>
                  <p className={styles.dialogIntro}>Jackett indexer: {jackettIndexers?.find((item) => item.id === jackettDraft.indexerId)?.name || jackettDraft.indexerId}</p>
                  {jackettDraft.supported?.map((type) => <label className={styles.checkboxLabel} key={type}>
                    <input type="checkbox" disabled={busy} checked={jackettDraft.mediaTypes.includes(type)} onChange={(event) => setJackettDraft((current) => ({ ...current,
                      mediaTypes: event.target.checked ? [...current.mediaTypes, type] : current.mediaTypes.filter((item) => item !== type),
                    }))} /> {type === "TV" ? "TV Shows" : type}
                  </label>)}
                  <label className={styles.checkboxLabel}><input type="checkbox" disabled={busy} checked={jackettDraft.enabled} onChange={(event) => setJackettDraft({ ...jackettDraft, enabled: event.target.checked })} /> Enabled</label>
                  <div className={styles.sourceActions}>
                    <button className={styles.saveButton} type="submit" disabled={busy || !jackettDraft.mediaTypes.length}>{busy ? "Verifying…" : "Verify and save"}</button>
                    <button className={styles.testButton} type="button" disabled={busy} onClick={() => jackettDraft.id ? closeDialog() : setJackettDraft(null)}>Back</button>
                  </div>
                </div>
              </form>
            ) : importDraft ? (
              <form onSubmit={(event) => { event.preventDefault(); if (importDraft.verificationFailure) return; void (importDraft.editId
                ? act("update-cardigann", { id: importDraft.editId, settings: importDraft.values, enabled: importDraft.enabled })
                : saveImported()); }}>
                <div className={styles.definitionPreview}>
                  <h3>Source details</h3>
                  <dl className={styles.definitionDetails}>
                    <div><dt>Name</dt><dd>{importDraft.definition.name}</dd></div>
                    {importDraft.definition.access ? <div><dt>Access</dt><dd>{accessLabel(importDraft.definition.access)}</dd></div> : null}
                    {importDraft.definition.language ? <div><dt>Language</dt><dd>{languageLabel(importDraft.definition.language)}</dd></div> : null}
                    {importDraft.definition.categories?.length ? <div><dt>Categories</dt><dd>{importDraft.definition.categories.join(", ")}</dd></div> : null}
                    {importDraft.definition.website ? <div><dt>Website</dt><dd className={styles.definitionUrl}>{importDraft.definition.website}</dd></div> : null}
                    {importDraft.definition.sourceUrl ? <div><dt>Definition</dt><dd className={styles.definitionUrl}>{importDraft.definition.sourceUrl}</dd></div> : null}
                  </dl>
                  {importDraft.definition.settings.some((field) => !field.informational) ? (
                    <p className={styles.definitionRequirement}>Text and password fields are optional, though some indexers may need them to connect. Choices without defaults still require a selection.</p>
                  ) : (
                    <p className={`${styles.definitionRequirement} ${styles.definitionReady}`}>✓ No account configuration required</p>
                  )}
                </div>
                <div className={styles.providerForm}>
                  {importDraft.definition.settings.some((field) => !field.informational) ? <h3>Indexer options</h3> : null}
                  {importDraft.definition.settings.map((field) => (
                    field.informational ? (
                      <p className={styles.definitionRequirement} key={field.name}>{field.label}</p>
                    ) : <div className={styles.field} key={field.name}>
                      <label htmlFor={`cardigann-${field.name}`}>{field.label}</label>
                      {field.type === "checkbox" ? (
                        <label className={styles.checkboxLabel}><input id={`cardigann-${field.name}`} type="checkbox" checked={Boolean(importDraft.values[field.name])} disabled={busy} onChange={(event) => updateImportedSetting(field.name, event.target.checked)} /> Enabled</label>
                      ) : field.type === "select" ? (
                        <select id={`cardigann-${field.name}`} required={field.required} disabled={busy} value={importDraft.values[field.name] || ""} onChange={(event) => updateImportedSetting(field.name, event.target.value)}>
                          {!field.required ? <option value="">Default</option> : null}
                          {Object.entries(field.options || {}).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
                        </select>
                      ) : (
                        <div className={styles.inputRow}><input id={`cardigann-${field.name}`} type={field.secret ? "password" : "text"} required={field.required && !field.configured} disabled={busy} value={importDraft.values[field.name] || ""} placeholder={field.configured ? "Leave blank to keep existing value" : ""} autoComplete={field.secret ? "new-password" : "off"} onChange={(event) => updateImportedSetting(field.name, event.target.value)} /></div>
                      )}
                    </div>
                  ))}
                  <label className={styles.checkboxLabel}><input type="checkbox" checked={importDraft.enabled} disabled={busy} onChange={(event) => updateImported("enabled", event.target.checked)} /> Enabled</label>
                  {importDraft.verificationFailure ? (
                    <div className={styles.verificationPrompt} role="alert">
                      <strong>Could not verify the indexer connection.</strong>
                      <p>The definition is valid and compatible with TorPlay, but the source could not currently be verified.</p>
                      <p>{importDraft.verificationFailure.message}</p>
                      <div className={styles.sourceActions}>
                        <button className={styles.testButton} type="button" disabled={busy} onClick={() => updateImported("verificationFailure", null)}>Cancel</button>
                        <button className={styles.saveButton} type="button" disabled={busy} onClick={() => void saveImported(true)}>{busy ? "Adding…" : "Add Anyway"}</button>
                      </div>
                    </div>
                  ) : (
                    <div className={styles.sourceActions}>
                      <button className={styles.saveButton} type="submit" disabled={busy}>{busy ? "Verifying…" : importDraft.editId ? "Verify and save" : "Add source"}</button>
                      <button className={styles.testButton} type="button" disabled={busy} onClick={() => importDraft.editId ? closeDialog() : setImportDraft(null)}>Cancel</button>
                    </div>
                  )}
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
            ) : !advanced ? (
              <div className={styles.sourceChoiceSections}>
                <section className={styles.providerForm}>
                  <h3>TorPlay Tested Sources</h3>
                  <p>Optional sources that TorPlay can configure directly. None are added or enabled automatically.</p>
                  <div className={styles.addSourceGrid}>
                    {testedSources.map((source) => (
                      <article className={styles.addSourceCard} key={source.id}>
                        <span><strong>{source.name}</strong><small>{source.mediaTypes.map((type) => type === "TV" ? "TV Shows" : type).join(" & ")}</small></span>
                        <button className={styles.testButton} type="button" disabled={busy || source.configured} onClick={() => void act("add-native", { id: source.id })}>{source.configured ? "Added" : "Add"}</button>
                      </article>
                    ))}
                  </div>
                </section>
                {jackettIndexers ? <section className={styles.providerForm}>
                  <h3>Jackett</h3>
                  <p>Add one configured Jackett indexer at a time. Movie and TV choices belong to each source.</p>
                  {jackettIndexers.length ? <div className={styles.addSourceGrid}>{jackettIndexers.map((item) => <article className={styles.addSourceCard} key={item.id}>
                    <span><strong>{item.name}</strong><small>Jackett indexer</small></span>
                    <button className={styles.testButton} type="button" disabled={busy || item.added} onClick={() => void chooseJackett(item.id)}>{item.added ? "Added" : "Add"}</button>
                  </article>)}</div> : <p>No configured Jackett indexers are available yet.</p>}
                </section> : <p className={styles.sectionNote}>To add Jackett sources, configure and validate Jackett under <a href="/settings#services">Services</a>.</p>}
                <CommunitySources busy={busy} configuredProviders={configuredProviders} onSelect={importDefinition} onAdvanced={() => { setAdvanced(true); setError(""); }} />
              </div>
            ) : (
              <div className={styles.addIndexerOptions}>
                <button className={styles.testButton} type="button" disabled={busy} onClick={() => { setAdvanced(false); setError(""); }}>Back to community sources</button>
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

  );
}
