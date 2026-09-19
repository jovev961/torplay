"use client";

import { useMemo, useState } from "react";
import { useProfile } from "./ProfileProvider.js";

async function readJson(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "The language list could not be loaded.");
  return data;
}

function fallbackLabel(code) {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) || code.toUpperCase();
  } catch {
    return code.toUpperCase();
  }
}

export default function ProfileManager() {
  const {
    activeProfile,
    create,
    profiles,
    remove,
    rename,
    select,
    updateSubtitlePreferences,
  } = useProfile();
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [editor, setEditor] = useState(null);
  const [catalog, setCatalog] = useState([]);
  const [catalogSource, setCatalogSource] = useState("");
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [languageSearch, setLanguageSearch] = useState("");
  const [settingsError, setSettingsError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const languageOptions = useMemo(() => {
    const byCode = new Map(catalog.map((language) => [language.code, language]));
    for (const code of editor?.enabledLanguages || []) {
      if (!byCode.has(code)) byCode.set(code, { code, label: fallbackLabel(code) });
    }
    return [...byCode.values()].sort((left, right) =>
      left.label.localeCompare(right.label) || left.code.localeCompare(right.code));
  }, [catalog, editor?.enabledLanguages]);
  const query = languageSearch.trim().toLowerCase();
  const filteredLanguages = query
    ? languageOptions.filter(({ code, label }) => (
      code.includes(query) || label.toLowerCase().includes(query)
    ))
    : languageOptions;
  const labels = new Map(languageOptions.map(({ code, label }) => [code, label]));

  async function add(event) {
    event.preventDefault();
    try {
      await create(name);
      setName("");
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  async function edit(profile) {
    const next = window.prompt("Profile name", profile.name);
    if (next === null) return;
    try { await rename(profile.id, next); setError(""); } catch (requestError) { setError(requestError.message); }
  }

  async function destroy(profile) {
    if (!window.confirm(`Delete ${profile.name} and all watch history?`)) return;
    try {
      await remove(profile.id);
      if (editor?.profileId === profile.id) setEditor(null);
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  async function openSubtitleSettings(profile) {
    setEditor({ profileId: profile.id, ...profile.subtitlePreferences });
    setLanguageSearch("");
    setSettingsError("");
    setSaved(false);
    if (catalog.length || catalogLoading) return;
    setCatalogLoading(true);
    try {
      const data = await readJson(await fetch("/api/subtitles/languages", { cache: "no-store" }));
      setCatalog(data.languages || []);
      setCatalogSource(data.source || "bundled");
    } catch (requestError) {
      setSettingsError(requestError.message);
    } finally {
      setCatalogLoading(false);
    }
  }

  function toggleLanguage(code) {
    setSaved(false);
    setSettingsError("");
    const selected = editor?.enabledLanguages.includes(code);
    if (selected && editor.enabledLanguages.length === 1) {
      setSettingsError("Choose at least one subtitle language.");
      return;
    }
    setEditor((current) => {
      if (!current) return current;
      const enabledLanguages = selected
        ? current.enabledLanguages.filter((language) => language !== code)
        : [...current.enabledLanguages, code];
      return {
        ...current,
        enabledLanguages,
        defaultLanguage: selected && current.defaultLanguage === code
          ? enabledLanguages[0]
          : current.defaultLanguage,
      };
    });
  }

  async function saveSubtitleSettings(event) {
    event.preventDefault();
    if (!editor) return;
    setSaving(true);
    setSaved(false);
    setSettingsError("");
    try {
      const profile = await updateSubtitlePreferences(editor.profileId, {
        defaultLanguage: editor.defaultLanguage,
        enabledLanguages: editor.enabledLanguages,
      });
      setEditor({ profileId: profile.id, ...profile.subtitlePreferences });
      setSaved(true);
    } catch (requestError) {
      setSettingsError(requestError.message);
    } finally {
      setSaving(false);
    }
  }

  const editingProfile = profiles.find((profile) => profile.id === editor?.profileId);

  return (
    <section className="profileManager panel">
      <div className="sectionHeading"><div><span className="eyebrow">Local profiles</span><h1>Manage Profiles</h1></div></div>
      {error ? <div className="notice error">{error}</div> : null}
      <div className="profileManageList">
        {profiles.map((profile) => (
          <article key={profile.id} className={profile.id === activeProfile?.id ? "active" : ""}>
            <strong>{profile.name}</strong>
            <div>
              {profile.id !== activeProfile?.id ? <button type="button" onClick={() => select(profile.id)}>Switch</button> : <span>Watching</span>}
              <button type="button" onClick={() => void edit(profile)}>Rename</button>
              <button type="button" onClick={() => void openSubtitleSettings(profile)}>Subtitles</button>
              <button type="button" onClick={() => void destroy(profile)}>Delete</button>
            </div>
          </article>
        ))}
      </div>

      {editor && editingProfile ? (
        <form className="subtitlePreferences" onSubmit={saveSubtitleSettings}>
          <div className="sectionHeading">
            <div>
              <span className="eyebrow">{editingProfile.name}</span>
              <h2>Subtitle languages</h2>
              <p>TorPlay searches every selected language and prefers the primary language automatically.</p>
            </div>
            <button className="textButton" type="button" onClick={() => setEditor(null)}>Close</button>
          </div>

          <div className="selectedLanguages" aria-label="Selected subtitle languages">
            {editor.enabledLanguages.map((code) => (
              <span key={code} className={code === editor.defaultLanguage ? "primary" : ""}>
                {labels.get(code) || fallbackLabel(code)}{code === editor.defaultLanguage ? " · Primary" : ""}
              </span>
            ))}
          </div>

          <label className="primaryLanguage">
            <span>Primary language</span>
            <select
              value={editor.defaultLanguage}
              onChange={(event) => {
                setSaved(false);
                setEditor((current) => ({ ...current, defaultLanguage: event.target.value }));
              }}
            >
              {editor.enabledLanguages.map((code) => (
                <option key={code} value={code}>{labels.get(code) || fallbackLabel(code)}</option>
              ))}
            </select>
          </label>

          <label className="languageSearch">
            <span>Find a language</span>
            <input
              type="search"
              value={languageSearch}
              onChange={(event) => setLanguageSearch(event.target.value)}
              placeholder="English, Macedonian, German…"
            />
          </label>

          {catalogLoading ? <div className="notice">Loading available languages…</div> : null}
          {!catalogLoading ? (
            <div className="languageChecklist">
              {filteredLanguages.map(({ code, label }) => (
                <label key={code}>
                  <input
                    type="checkbox"
                    checked={editor.enabledLanguages.includes(code)}
                    onChange={() => toggleLanguage(code)}
                  />
                  <span>{label}</span>
                  <small>{code}</small>
                </label>
              ))}
              {filteredLanguages.length === 0 ? <p>No matching languages.</p> : null}
            </div>
          ) : null}

          {catalogSource ? <small className="languageSource">Language list: {catalogSource === "bundled" ? "TorPlay fallback" : catalogSource}.</small> : null}
          {settingsError ? <div className="notice error" role="alert">{settingsError}</div> : null}
          {saved ? <div className="notice success" role="status">Subtitle preferences saved.</div> : null}
          <div className="subtitlePreferenceActions">
            <button className="primaryButton compact" type="submit" disabled={saving || catalogLoading}>
              {saving ? "Saving…" : "Save preferences"}
            </button>
            <button className="secondaryButton" type="button" onClick={() => setEditor(null)}>Cancel</button>
          </div>
        </form>
      ) : null}

      <form className="profileForm inlineProfileForm" onSubmit={add}>
        <label><span>New profile</span><input maxLength="50" value={name} onChange={(event) => setName(event.target.value)} /></label>
        <button className="primaryButton compact" type="submit">Add Profile</button>
      </form>
    </section>
  );
}
