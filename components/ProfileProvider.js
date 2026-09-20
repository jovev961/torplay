"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useState } from "react";
import AvatarPicker from "./AvatarPicker.js";
import ProfileAvatar from "./ProfileAvatar.js";
import { DEFAULT_PROFILE_AVATAR_ID } from "../lib/profiles/avatars.js";

const STORAGE_KEY = "torplay:selected-profile:v1";
const ProfileContext = createContext(null);

async function readJson(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Profile request failed.");
  return data;
}

function ProfileGate({ profiles, create, select }) {
  const [adding, setAdding] = useState(profiles.length === 0);
  const [name, setName] = useState("");
  const [avatarId, setAvatarId] = useState(DEFAULT_PROFILE_AVATAR_ID);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const profile = await create(name, avatarId);
      select(profile.id, { navigate: false, profile });
    } catch (submitError) {
      setError(submitError.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="profileGate">
      <div className="profileGateCard">
        <span className="brand">TorPlay</span>
        <div>
          <h1>Who&apos;s watching?</h1>
          <p>Choose a profile to continue.</p>
        </div>
        {!adding ? (
          <>
            <div className="profileChoices" aria-label="Choose a profile">
              {profiles.map((profile) => (
                <button type="button" key={profile.id} onClick={() => select(profile.id)}>
                  <ProfileAvatar avatarId={profile.avatarId} size="large" />
                  <span>{profile.name}</span>
                </button>
              ))}
              <button className="addProfileChoice" type="button" onClick={() => setAdding(true)}>
                <span className="addProfileAvatar" aria-hidden="true">+</span>
                <span>Add Profile</span>
              </button>
            </div>
            <Link className="secondaryButton profileManageLink" href="/profiles">Manage Profiles</Link>
          </>
        ) : (
          <form className="profileCreateForm" onSubmit={submit}>
            <AvatarPicker value={avatarId} onChange={setAvatarId} />
            <label>
              <span>Profile name</span>
              <input
                autoFocus
                maxLength="50"
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoComplete="off"
              />
            </label>
            <div className="profileFormActions">
              <button className="primaryButton compact" type="submit" disabled={submitting}>
                {submitting ? "Creating…" : "Create Profile"}
              </button>
              {profiles.length ? (
                <button className="secondaryButton" type="button" onClick={() => setAdding(false)}>
                  Cancel
                </button>
              ) : null}
            </div>
            {error ? <p className="notice error" role="alert">{error}</p> : null}
          </form>
        )}
      </div>
    </div>
  );
}

export function ProfileProvider({ children }) {
  const pathname = usePathname();
  const router = useRouter();
  const [profiles, setProfiles] = useState([]);
  const [activeProfile, setActiveProfile] = useState(null);
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/profiles", { cache: "no-store" })
      .then(readJson)
      .then(({ profiles: items }) => {
        if (cancelled) return;
        setProfiles(items);
        let selectedId = null;
        try { selectedId = window.localStorage.getItem(STORAGE_KEY); } catch {}
        setActiveProfile(items.find((item) => item.id === selectedId) || null);
        setStatus("ready");
      })
      .catch((loadError) => {
        if (cancelled) return;
        setError(loadError.message);
        setStatus("error");
      });
    return () => { cancelled = true; };
  }, []);

  function select(id, { navigate = true, profile: providedProfile = null } = {}) {
    const profile = providedProfile || profiles.find((item) => item.id === id) || null;
    setActiveProfile(profile);
    try {
      if (profile) window.localStorage.setItem(STORAGE_KEY, profile.id);
      else window.localStorage.removeItem(STORAGE_KEY);
    } catch {}
    if (navigate) router.push("/");
  }

  async function create(name, avatarId) {
    const data = await readJson(await fetch("/api/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, avatarId }),
    }));
    setProfiles((items) => [...items, data.profile]);
    return data.profile;
  }

  async function update(id, changes) {
    const data = await readJson(await fetch(`/api/profiles/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(changes),
    }));
    setProfiles((items) => items.map((item) => item.id === id ? data.profile : item));
    setActiveProfile((profile) => profile?.id === id ? data.profile : profile);
    return data.profile;
  }

  async function rename(id, name) {
    return update(id, { name });
  }

  async function updateSubtitlePreferences(id, preferences) {
    const data = await readJson(await fetch(
      `/api/profiles/${encodeURIComponent(id)}/subtitle-preferences`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(preferences),
      },
    ));
    setProfiles((items) => items.map((item) => item.id === id ? data.profile : item));
    setActiveProfile((profile) => profile?.id === id ? data.profile : profile);
    return data.profile;
  }

  async function remove(id) {
    const response = await fetch(`/api/profiles/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!response.ok) throw new Error("Could not delete the profile.");
    setProfiles((items) => items.filter((item) => item.id !== id));
    if (activeProfile?.id === id) {
      setActiveProfile(null);
      try { window.localStorage.removeItem(STORAGE_KEY); } catch {}
    }
  }

  const value = {
    activeProfile,
    create,
    error,
    profiles,
    remove,
    rename,
    select,
    status,
    update,
    updateSubtitlePreferences,
  };
  const profilePage = pathname.startsWith("/profiles");

  return (
    <ProfileContext.Provider value={value}>
      {status === "loading" ? <div className="profileLoading">Loading profiles…</div> : null}
      {status === "ready" && !activeProfile && !profilePage ? (
        <ProfileGate profiles={profiles} create={create} select={select} />
      ) : null}
      {status === "error" ? <div className="profileWarning">Profiles unavailable: {error}. Playback is still available.</div> : null}
      {children}
    </ProfileContext.Provider>
  );
}

export function useProfile() {
  const context = useContext(ProfileContext);
  if (!context) throw new Error("useProfile must be used inside ProfileProvider.");
  return context;
}
