"use client";

import { useMemo, useState } from "react";
import AvatarPicker from "./AvatarPicker.js";
import ProfileAvatar from "./ProfileAvatar.js";
import { useProfile } from "./ProfileProvider.js";
import { DEFAULT_PROFILE_AVATAR_ID } from "../lib/profiles/avatars.js";

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

export default function ProfileManager({ startAdding = false }) {
  const {
    activeProfile,
    create,
    profiles,
    remove,
    select,
    update,
    updateSubtitlePreferences,
  } = useProfile();
  const [mode, setMode] = useState(startAdding ? "add" : "manage");
  const [newProfile, setNewProfile] = useState({ name: "", avatarId: DEFAULT_PROFILE_AVATAR_ID });
  const [error, setError] = useState("");
  const [editor, setEditor] = useState(null);
  const [catalog, setCatalog] = useState([]);
  const [catalogSource, setCatalogSource] = useState("");
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [languageSearch, setLanguageSearch] = useState("");
  const [settingsError, setSettingsError] = useState("");
  const [savingIdentity, setSavingIdentity] = useState(false);
  const [savingPreferences, setSavingPreferences] = useState(false);
  const [saved, setSaved] = useState("");

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
    setError("");
    try {
      await create(newProfile.name, newProfile.avatarId);
      setNewProfile({ name: "", avatarId: DEFAULT_PROFILE_AVATAR_ID });
      setMode("manage");
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  async function loadLanguages() {
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

  function openEditor(profile) {
    setMode("manage");
    setEditor({
      profileId: profile.id,
      name: profile.name,
      avatarId: profile.avatarId,
      ...profile.subtitlePreferences,
    });
    setLanguageSearch("");
    setError("");
    setSettingsError("");
    setSaved("");
    void loadLanguages();
  }

  async function saveIdentity(event) {
    event.preventDefault();
    if (!editor) return;
    setSavingIdentity(true);
    setSaved("");
    setError("");
    try {
      const profile = await update(editor.profileId, {
        name: editor.name,
        avatarId: editor.avatarId,
      });
      setEditor((current) => ({ ...current, name: profile.name, avatarId: profile.avatarId }));
      setSaved("Profile saved.");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSavingIdentity(false);
    }
  }

  async function destroy(profile) {
    if (!window.confirm(`Delete ${profile.name} and all watch history?`)) return;
    try {
      await remove(profile.id);
      setEditor(null);
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  function toggleLanguage(code) {
    setSaved("");
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
    setSavingPreferences(true);
    setSaved("");
    setSettingsError("");
    try {
      const profile = await updateSubtitlePreferences(editor.profileId, {
        defaultLanguage: editor.defaultLanguage,
        enabledLanguages: editor.enabledLanguages,
      });
      setEditor((current) => ({ ...current, ...profile.subtitlePreferences }));
      setSaved("Subtitle preferences saved.");
    } catch (requestError) {
      setSettingsError(requestError.message);
    } finally {
      setSavingPreferences(false);
    }
  }

  const editingProfile = profiles.find((profile) => profile.id === editor?.profileId);

  return (
    <section className="profileManager">
      <div className="profileManagerHeading">
        <div><span className="eyebrow">Local profiles</span><h1>Manage Profiles</h1></div>
        <p>Choose who is watching and personalize their profile.</p>
      </div>
      {error ? <div className="notice error" role="alert">{error}</div> : null}

      {mode === "add" ? (
        <form className="profileEditorPanel profileCreatePanel" onSubmit={add}>
          <div className="profileEditorHeading">
            <div><span className="eyebrow">New viewer</span><h2>Add Profile</h2></div>
            {profiles.length ? <button className="textButton" type="button" onClick={() => setMode("manage")}>Cancel</button> : null}
          </div>
          <AvatarPicker
            value={newProfile.avatarId}
            onChange={(avatarId) => setNewProfile((profile) => ({ ...profile, avatarId }))}
          />
          <label className="profileNameField">
            <span>Profile name</span>
            <input
              autoFocus
              maxLength="50"
              value={newProfile.name}
              onChange={(event) => setNewProfile((profile) => ({ ...profile, name: event.target.value }))}
              autoComplete="off"
            />
          </label>
          <div className="profileFormActions">
            <button className="primaryButton compact" type="submit">Create Profile</button>
            {profiles.length ? <button className="secondaryButton" type="button" onClick={() => setMode("manage")}>Cancel</button> : null}
          </div>
        </form>
      ) : (
        <>
          <div className="profileCardGrid" aria-label="Profiles">
            {profiles.map((profile) => (
              <button
                type="button"
                key={profile.id}
                className={profile.id === activeProfile?.id ? "profileManageCard active" : "profileManageCard"}
                onClick={() => openEditor(profile)}
              >
                <ProfileAvatar avatarId={profile.avatarId} size="large" />
                <strong>{profile.name}</strong>
                <span>{profile.id === activeProfile?.id ? "Currently watching" : "Edit profile"}</span>
              </button>
            ))}
            <button
              className="profileManageCard addProfileCard"
              type="button"
              onClick={() => {
                setEditor(null);
                setMode("add");
                setError("");
              }}
            >
              <span className="addProfileAvatar" aria-hidden="true">+</span>
              <strong>Add Profile</strong>
              <span>Create another local viewer</span>
            </button>
          </div>

          {editor && editingProfile ? (
            <div className="profileEditorPanel">
              <div className="profileEditorHeading">
                <div>
                  <span className="eyebrow">{editingProfile.id === activeProfile?.id ? "Currently watching" : "Profile settings"}</span>
                  <h2>{editingProfile.name}</h2>
                </div>
                <button className="textButton" type="button" onClick={() => setEditor(null)}>Close</button>
              </div>

              <form className="profileIdentityForm" onSubmit={saveIdentity}>
                <AvatarPicker
                  value={editor.avatarId}
                  onChange={(avatarId) => {
                    setSaved("");
                    setEditor((current) => ({ ...current, avatarId }));
                  }}
                  legend="Profile avatar"
                />
                <label className="profileNameField">
                  <span>Profile name</span>
                  <input
                    maxLength="50"
                    value={editor.name}
                    onChange={(event) => {
                      setSaved("");
                      setEditor((current) => ({ ...current, name: event.target.value }));
                    }}
                  />
                </label>
                <div className="profileFormActions">
                  <button className="primaryButton compact" type="submit" disabled={savingIdentity}>
                    {savingIdentity ? "Saving…" : "Save profile"}
                  </button>
                  {editingProfile.id !== activeProfile?.id ? (
                    <button className="secondaryButton" type="button" onClick={() => select(editingProfile.id)}>
                      Switch to profile
                    </button>
                  ) : null}
                </div>
              </form>

              <form className="subtitlePreferences" onSubmit={saveSubtitleSettings}>
                <div className="sectionHeading">
                  <div>
                    <span className="eyebrow">Playback preferences</span>
                    <h2>Subtitle languages</h2>
                    <p>TorPlay searches every selected language and prefers the primary language automatically.</p>
                  </div>
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
                      setSaved("");
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
                <div className="subtitlePreferenceActions">
                  <button className="primaryButton compact" type="submit" disabled={savingPreferences || catalogLoading}>
                    {savingPreferences ? "Saving…" : "Save preferences"}
                  </button>
                </div>
              </form>

              {saved ? <div className="notice success" role="status">{saved}</div> : null}
              <div className="profileDangerZone">
                <div><strong>Delete profile</strong><span>This also removes the profile&apos;s watch history.</span></div>
                <button type="button" onClick={() => void destroy(editingProfile)}>Delete {editingProfile.name}</button>
              </div>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
