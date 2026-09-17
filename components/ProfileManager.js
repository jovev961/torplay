"use client";

import { useState } from "react";
import { useProfile } from "./ProfileProvider.js";

export default function ProfileManager() {
  const { activeProfile, create, profiles, remove, rename, select } = useProfile();
  const [name, setName] = useState("");
  const [error, setError] = useState("");

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
    try { await remove(profile.id); setError(""); } catch (requestError) { setError(requestError.message); }
  }

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
              <button type="button" onClick={() => void destroy(profile)}>Delete</button>
            </div>
          </article>
        ))}
      </div>
      <form className="profileForm inlineProfileForm" onSubmit={add}>
        <label><span>New profile</span><input maxLength="50" value={name} onChange={(event) => setName(event.target.value)} /></label>
        <button className="primaryButton compact" type="submit">Add Profile</button>
      </form>
    </section>
  );
}
