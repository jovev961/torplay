"use client";

import { useState } from "react";
import { sourceRequest } from "./source-request.js";
import { filterCommunityEntries, unexploredCommunityEntries } from "./community-source-filters.js";
import styles from "./SettingsManager.module.css";

export default function CommunitySources({ busy, onSelect, onAdvanced, configuredProviders = [] }) {
  const [directory, setDirectory] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [media, setMedia] = useState("all");
  const [access, setAccess] = useState("all");
  async function browse(refresh = false) {
    setLoading(true); setError("");
    try {
      const result = await sourceRequest("list-community-definitions", undefined, refresh);
      if (!Array.isArray(result.entries) || result.entries.some((entry) => !Array.isArray(entry.mediaTypes) || typeof entry.anime !== "boolean")) {
        throw new Error("The community list needs a refresh before it can be filtered. Try Refresh list.");
      }
      setDirectory(result);
    }
    catch (error) { setError(error.message); }
    finally { setLoading(false); }
  }
  const available = unexploredCommunityEntries(directory?.entries || [], configuredProviders);
  const entries = filterCommunityEntries(available, { query, media, access });
  const filters = [
    { id: "all", label: "All", count: available.length },
    { id: "Movies", label: "Movies", count: available.filter((entry) => entry.mediaTypes.includes("Movies")).length },
    { id: "TV", label: "TV / Series", count: available.filter((entry) => entry.mediaTypes.includes("TV")).length },
    { id: "Anime", label: "Anime", count: available.filter((entry) => entry.anime).length },
  ];
  const accessLabel = (access) => ({ public: "Public", "semi-private": "Semi-public", private: "Private" })[access] || "Access unknown";
  return (
    <section className={styles.providerForm}>
      <div className={styles.communityIntro}>
        <div><h3>Explore Cardigann indexers</h3><p>Find a source for movies, TV, or anime. Already-added indexers are hidden. Access and category labels come from community definitions; TorPlay checks compatibility when you select one.</p></div>
      </div>
      <p>The community list loads from Prowlarr on GitHub only when you choose Browse.</p>
      <div className={styles.sourceActions}>
        <button className={styles.saveButton} disabled={loading || busy} type="button" onClick={() => void browse(Boolean(directory))}>{loading ? "Loading sources…" : directory ? "Refresh list" : "Browse community sources"}</button>
        <button className={styles.testButton} disabled={loading || busy} type="button" onClick={onAdvanced}>Advanced setup</button>
      </div>
      {error ? <div className="notice error" role="alert">{error} <button type="button" disabled={loading || busy} onClick={() => void browse(true)}>Retry</button></div> : null}
      {directory ? <>
        <div className={styles.communityToolbar}>
          <label className={styles.field}>Search indexers<input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by name" /></label>
          <div className={styles.communityFilters} role="group" aria-label="Filter Cardigann indexers by media type">
            {filters.map((filter) => <button key={filter.id} type="button" className={`${styles.communityFilter} ${media === filter.id ? styles.communityFilterActive : ""}`} aria-pressed={media === filter.id} onClick={() => setMedia(filter.id)}>{filter.label} <span>{filter.count}</span></button>)}
          </div>
          <label className={styles.communityAccess}>Access
            <select value={access} onChange={(event) => setAccess(event.target.value)}>
              <option value="all">All</option>
              <option value="public">Public</option>
              <option value="semi-private">Semi-public</option>
              <option value="private">Private</option>
            </select>
          </label>
        </div>
        <p className={styles.communityCount} role="status">Showing {entries.length} of {available.length} indexers you have not added. Sources supporting multiple categories appear in each.</p>
        <ul className={styles.communityList}>
          {entries.map((entry) => <li key={entry.id}><button type="button" className={styles.communityItem} disabled={busy || loading} onClick={() => onSelect(entry.id, directory.revision)}>
            <strong>{entry.name}</strong>
            <span className={styles.communityItemMeta}>
              {entry.mediaTypes.map((type) => <span className={styles.sourceBadge} key={type}>{type === "TV" ? "TV / Series" : type}</span>)}
              {entry.anime ? <span className={styles.sourceBadge}>Anime</span> : null}
              <span className={`${styles.sourceBadge} ${entry.access === "public" ? styles.publicBadge : entry.access === "private" ? styles.privateBadge : styles.semiBadge}`}>{accessLabel(entry.access)}</span>
              {entry.requiresFlareSolverr ? <span className={styles.sourceBadge}>FlareSolverr</span> : null}
            </span>
          </button></li>)}
        </ul>
        {!entries.length ? <p>No indexers match these filters.</p> : null}
      </> : null}
    </section>
  );
}
