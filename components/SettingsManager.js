"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  SETTINGS_SECTIONS,
  settingsSectionFromHash,
  settingsValidationRequest,
} from "../lib/settings/navigation.js";
import styles from "./SettingsManager.module.css";
import NetworkAccess from "./NetworkAccess.js";
import TorrentIndexerManager from "./TorrentIndexerManager.js";
import DebridSettings from "./DebridSettings.js";

const statusLabels = {
  valid: "Valid",
  invalid: "Invalid",
  unreachable: "Unreachable",
  missing: "Missing",
  unconfigured: "Not configured",
  checking: "Checking…",
  available: "Available",
  unavailable: "Unavailable",
  disabled: "Disabled",
  pending: "Not saved",
};

function key(providerId, fieldId) {
  return `${providerId}:${fieldId}`;
}

function draftsFrom(providers) {
  return Object.fromEntries(providers.flatMap((provider) => provider.fields.flatMap((field) => (
    field.secret ? [] : [[key(provider.id, field.id), field.value || ""]]
  ))));
}

async function readJson(response) {
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || "Settings request failed.");
  return data;
}

function ProviderStatus({ provider, validation }) {
  const fallback = provider.configured
    ? { status: "checking", message: "Checking the configured service." }
    : provider.required
      ? { status: "missing", message: "Required configuration is missing." }
      : { status: "unconfigured", message: "This optional service is not configured." };
  const current = validation || fallback;
  return (
    <div className={styles.providerStatus}>
      <span className={`${styles.statusBadge} ${styles[current.status] || ""}`}>
        {statusLabels[current.status] || "Unknown"}
      </span>
      <span>{current.message}</span>
    </div>
  );
}

function RuntimeStatus({ components }) {
  if (!components.length) return <p className={styles.muted}>Supervisor status is unavailable in this runtime.</p>;
  return (
    <div className={styles.runtimeGrid}>
      {components.map((component) => (
        <div key={component.name}>
          <span>{component.name}</span>
          <strong className={component.status === "OK" ? styles.ok : ""}>{component.status}</strong>
        </div>
      ))}
    </div>
  );
}

export default function SettingsManager() {
  const [selectedSection, setSelectedSection] = useState("general");
  const [snapshot, setSnapshot] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [secrets, setSecrets] = useState({});
  const [visibleSecrets, setVisibleSecrets] = useState({});
  const [validations, setValidations] = useState({});
  const [saving, setSaving] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [quitting, setQuitting] = useState(false);

  useEffect(() => {
    function selectHashSection() {
      setSelectedSection(settingsSectionFromHash(window.location.hash));
    }
    selectHashSection();
    window.addEventListener("hashchange", selectHashSection);
    return () => window.removeEventListener("hashchange", selectHashSection);
  }, []);

  const validateProviders = useCallback(async (providerIds, { refresh = false } = {}) => {
    if (!providerIds.length) return;
    setValidations((current) => ({
      ...current,
      ...Object.fromEntries(providerIds.map((id) => [id, {
        status: "checking",
        message: "Checking the configured service.",
      }])),
    }));
    try {
      const data = await readJson(await fetch("/api/settings/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providers: providerIds, refresh }),
      }));
      setValidations((current) => ({
        ...current,
        ...Object.fromEntries(data.results.map((item) => [item.provider, item])),
      }));
    } catch (validationError) {
      setValidations((current) => ({
        ...current,
        ...Object.fromEntries(providerIds.map((id) => [id, {
          status: "unreachable",
          message: validationError.message,
        }])),
      }));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/settings", { cache: "no-store" })
      .then(readJson)
      .then((data) => {
        if (cancelled) return;
        setSnapshot(data);
        setDrafts(draftsFrom(data.providers));
      })
      .catch((loadError) => { if (!cancelled) setError(loadError.message); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const request = settingsValidationRequest(snapshot, selectedSection);
    if (request.providerIds.length) void validateProviders(request.providerIds, request);
  }, [selectedSection, snapshot, validateProviders]);

  async function saveProvider(provider) {
    const values = {};
    for (const field of provider.fields) {
      const fieldKey = key(provider.id, field.id);
      if (field.managedExternally) continue;
      if (field.secret) {
        if (secrets[fieldKey]?.trim()) values[field.id] = secrets[fieldKey];
      } else if ((drafts[fieldKey] || "") !== (field.value || "")) {
        values[field.id] = drafts[fieldKey] || "";
      }
    }
    setSaving(provider.id);
    setNotice("");
    setError("");
    try {
      const data = await readJson(await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: provider.id, values }),
      }));
      setSnapshot(data);
      setDrafts(draftsFrom(data.providers));
      setSecrets((current) => Object.fromEntries(
        Object.entries(current).filter(([fieldKey]) => !fieldKey.startsWith(`${provider.id}:`)),
      ));
      setNotice(`${provider.name} settings saved.`);
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setSaving("");
    }
  }

  async function removeCredential(provider, field) {
    if (!window.confirm(`Remove the configured ${provider.name} ${field.label}?`)) return;
    setSaving(provider.id);
    setNotice("");
    setError("");
    try {
      const data = await readJson(await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: provider.id, values: {}, remove: [field.id] }),
      }));
      setSnapshot(data);
      setNotice(`${provider.name} ${field.label} removed.`);
    } catch (removeError) {
      setError(removeError.message);
    } finally {
      setSaving("");
    }
  }

  async function quitTorPlay() {
    if (!window.confirm("Quit TorPlay? Streaming and background downloads will stop.")) return;
    setQuitting(true);
    setError("");
    try {
      await readJson(await fetch("/api/runtime/quit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }));
      setNotice("TorPlay is shutting down. You can close this browser tab.");
    } catch (quitError) {
      setError(quitError.message);
      setQuitting(false);
    }
  }

  if (error && !snapshot) return <div className="notice error" role="alert">{error}</div>;
  if (!snapshot) return <div className="notice">Loading Settings…</div>;
  const serviceProviders = snapshot.providers.filter((provider) => provider.section === "services");
  const subtitleProviders = snapshot.providers.filter((provider) => provider.section === "subtitles");

  function providerHasChanges(provider) {
    return provider.fields.some((field) => {
      if (field.managedExternally) return false;
      const fieldKey = key(provider.id, field.id);
      return field.secret
        ? Boolean(secrets[fieldKey]?.trim())
        : (drafts[fieldKey] || "") !== (field.value || "");
    });
  }

  function providerCard(provider) {
    return (
      <article className={styles.providerCard} key={provider.id}>
        <div className={styles.providerHeading}>
          <div>
            <div className={styles.providerTitle}>
              <h3>{provider.name}</h3>
              <span>{provider.required ? "Required" : "Optional"}</span>
            </div>
            <p>{provider.description}</p>
          </div>
          <button className={styles.testButton} type="button" onClick={() => validateProviders([provider.id])}>
            Test connection
          </button>
        </div>
        <ProviderStatus provider={provider} validation={validations[provider.id]} />
        <p className={styles.helpText}>{provider.helpText} <a href={provider.helpUrl} target="_blank" rel="noreferrer">Open official instructions ↗</a></p>
        {snapshot.canEdit ? (
          <div className={styles.providerForm}>
            {provider.fields.map((field) => {
              const fieldKey = key(provider.id, field.id);
              const disabled = saving === provider.id || field.managedExternally;
              return (
                <div className={styles.field} key={field.id}>
                  <label htmlFor={fieldKey}>{field.label}{field.required ? " *" : ""}</label>
                  <div className={styles.inputRow}>
                    <input
                      id={fieldKey}
                      type={field.secret && !visibleSecrets[fieldKey] ? "password" : "text"}
                      value={field.secret ? secrets[fieldKey] || "" : drafts[fieldKey] || ""}
                      placeholder={field.secret && field.configured ? "Configured — enter a value to replace" : ""}
                      autoComplete={field.secret ? "new-password" : "off"}
                      disabled={disabled}
                      onChange={(event) => (field.secret ? setSecrets : setDrafts)((current) => ({
                        ...current,
                        [fieldKey]: event.target.value,
                      }))}
                    />
                    {field.secret ? (
                      <button
                        className={styles.inlineButton}
                        type="button"
                        disabled={disabled}
                        aria-label={`${visibleSecrets[fieldKey] ? "Hide" : "Show"} ${provider.name} ${field.label}`}
                        onClick={() => setVisibleSecrets((current) => ({ ...current, [fieldKey]: !current[fieldKey] }))}
                      >
                        {visibleSecrets[fieldKey] ? "Hide" : "Show"}
                      </button>
                    ) : null}
                    {field.secret && field.configured && !field.managedExternally ? (
                      <button className={styles.removeButton} type="button" disabled={disabled} onClick={() => removeCredential(provider, field)}>
                        Remove
                      </button>
                    ) : null}
                  </div>
                  {field.managedExternally ? <small>Managed by the host environment and read-only here.</small> : null}
                </div>
              );
            })}
            <button
              className={styles.saveButton}
              type="button"
              disabled={saving === provider.id || !providerHasChanges(provider)}
              onClick={() => saveProvider(provider)}
            >
              {saving === provider.id ? "Saving…" : `Save ${provider.name}`}
            </button>
          </div>
        ) : null}
      </article>
    );
  }

  return (
    <div className={styles.settingsLayout}>
      <nav className={styles.settingsNav} aria-label="Settings sections">
        {SETTINGS_SECTIONS.map(([id, label]) => (
          <a
            className={selectedSection === id ? styles.activeNavItem : ""}
            href={`#${id}`}
            aria-current={selectedSection === id ? "page" : undefined}
            key={id}
            onClick={() => setSelectedSection(id)}
          >
            {label}
          </a>
        ))}
      </nav>
      <div className={styles.settingsContent}>
        {!snapshot.canEdit ? (
          <div className="notice" role="status">
            Settings can be changed only through TorPlay on your private local network.
          </div>
        ) : null}
        {notice ? <div className="notice success" role="status">{notice}</div> : null}
        {error ? <div className="notice error" role="alert">{error}</div> : null}

        {selectedSection === "general" ? <section className={styles.settingsSection} id="general">
          <div className={styles.sectionHeading}><span>01</span><div><h2>General</h2><p>Runtime and local configuration health.</p></div></div>
          <div className={styles.summaryCard}>
            <dl>
              <div><dt>Runtime</dt><dd>{snapshot.runtime.mode}</dd></div>
              <div><dt>Configuration</dt><dd>{snapshot.runtime.configurationWritable ? "Writable" : "Unavailable"}</dd></div>
              <div><dt>Editing</dt><dd>{snapshot.canEdit ? "Local network enabled" : "Unavailable outside the local network"}</dd></div>
            </dl>
            <RuntimeStatus components={snapshot.runtime.components} />
          </div>
          <NetworkAccess />
          {snapshot.runtime.canQuit ? (
            <div className={styles.summaryCard}>
              <h3>App lifecycle</h3>
              <p>Closing this browser tab does not stop TorPlay. Launch the AppImage again to reopen it.</p>
              <button className={styles.quitButton} type="button" disabled={quitting} onClick={quitTorPlay}>
                {quitting ? "Quitting…" : "Quit TorPlay"}
              </button>
            </div>
          ) : null}
        </section> : null}

        {selectedSection === "services" ? <section className={styles.settingsSection} id="services">
          <div className={styles.sectionHeading}><span>02</span><div><h2>Services</h2><p>Metadata, source discovery, debrid playback, and external search integrations.</p></div></div>
          <div className={styles.providerGrid}>{serviceProviders.map(providerCard)}</div>
          <DebridSettings canEdit={snapshot.canEdit} section="services" />
        </section> : null}

        {selectedSection === "torrent-sources" ? <section className={styles.settingsSection} id="torrent-sources">
          <div className={styles.sectionHeading}><span>03</span><div><h2>Torrent Sources</h2><p>Choose the third-party sources TorPlay may use for movie and TV searches.</p></div></div>
          <div className={styles.sourceNotice}>
            TorPlay does not host or provide media files. Content and torrent metadata are obtained from third-party sources selected by the user. Users are responsible for ensuring that their use of TorPlay and configured sources complies with applicable laws and the rights of content owners.
          </div>
          <TorrentIndexerManager
            nativeSources={snapshot.nativeSources}
            initialCustomProviders={snapshot.customProviders}
            canEdit={snapshot.canEdit}
            onCustomChanged={async () => {
              const data = await readJson(await fetch("/api/settings", { cache: "no-store" }));
              setSnapshot(data);
              return data;
            }}
          />
        </section> : null}

        {selectedSection === "subtitles" ? <section className={styles.settingsSection} id="subtitles">
          <div className={styles.sectionHeading}><span>04</span><div><h2>Subtitles</h2><p>Optional external subtitle providers.</p></div></div>
          <div className={styles.providerGrid}>{subtitleProviders.map(providerCard)}</div>
          <p className={styles.sectionNote}>Preferred subtitle languages remain profile-specific. <Link href="/profiles">Manage profile languages →</Link></p>
        </section> : null}

        {selectedSection === "playback" ? <section className={styles.settingsSection} id="playback">
          <div className={styles.sectionHeading}><span>05</span><div><h2>Playback</h2><p>Current playback capabilities and safe runtime defaults.</p></div></div>
          <div className={styles.capabilityGrid}>
            <div><span>Native formats</span><strong>{snapshot.playback.nativeFormats.join(" · ")}</strong></div>
            <div><span>Prepared playback</span><strong>{snapshot.playback.hlsAvailable ? "HLS available" : "Unavailable"}</strong></div>
            <div><span>Media tools</span><strong>{snapshot.playback.bundledMediaTools ? "Bundled FFmpeg / FFprobe" : "Unavailable"}</strong></div>
            <div><span>Buffer target</span><strong>{snapshot.playback.bufferAheadSeconds} seconds</strong></div>
            <div><span>Subtitle cache</span><strong>{snapshot.playback.subtitleCacheDays} days</strong></div>
          </div>
          <DebridSettings canEdit={snapshot.canEdit} section="playback" />
          <p className={styles.sectionNote}>Network ports, storage paths, trackers, and executable overrides remain owner-managed runtime configuration.</p>
        </section> : null}

        {selectedSection === "about" ? <section className={styles.settingsSection} id="about">
          <div className={styles.sectionHeading}><span>06</span><div><h2>About</h2><p>Build and project information.</p></div></div>
          <div className={styles.summaryCard}>
            <dl>
              <div><dt>Version</dt><dd>{snapshot.about.version}</dd></div>
              <div><dt>License</dt><dd>{snapshot.about.license}</dd></div>
              <div><dt>Project</dt><dd><a href={snapshot.about.repositoryUrl} target="_blank" rel="noreferrer">GitHub repository ↗</a></dd></div>
            </dl>
            <p className={styles.muted}>Metadata by TMDB. IMDb-compatible ratings and lookups may use OMDb. Subtitle results may use OpenSubtitles or SubDL when configured.</p>
          </div>
        </section> : null}
      </div>
    </div>
  );
}
