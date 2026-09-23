"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import VideoPlayer from "./VideoPlayer.js";
import { useProfile } from "./ProfileProvider.js";
import { releaseTorrentSession } from "./useSourceLookup.js";
import { formatFileSize } from "../lib/video/episode-display.js";

async function json(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Debrid request failed.");
  return data;
}

const label = { "real-debrid": "Real-Debrid", torbox: "TorBox" };
const active = new Set(["submitting", "queued", "downloading", "processing", "awaiting-selection"]);

function historyMedia(item, file) {
  const context = item?.mediaContext;
  if (!context?.tmdbId) return null;
  if (context.type === "movie") return {
    mediaType: "movie", tmdbId: context.tmdbId, title: context.title || item.name,
  };
  if (context.type !== "show") return null;
  const mapped = item.episodeMappings?.find((entry) => entry.fileId === file.providerId);
  if (mapped) return {
    mediaType: "tv", tmdbId: context.tmdbId, title: context.title || item.name,
    seasonNumber: mapped.season, episodeNumber: mapped.episode,
  };
  if (file.providerId === item.selectedFileId) return {
    mediaType: "tv", tmdbId: context.tmdbId, title: context.title || item.name,
    seasonNumber: context.season, episodeNumber: context.episode,
  };
  const match = /S(\d{1,2})E(\d{1,3})/i.exec(file.name);
  return match ? {
    mediaType: "tv", tmdbId: context.tmdbId, title: context.title || item.name,
    seasonNumber: Number(match[1]), episodeNumber: Number(match[2]),
  } : null;
}

export default function DebridLibraryClient() {
  const { activeProfile } = useProfile();
  const [filter, setFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [items, setItems] = useState([]);
  const [providers, setProviders] = useState([]);
  const [selected, setSelected] = useState(null);
  const [session, setSession] = useState(null);
  const [playingFile, setPlayingFile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [downloadFileIds, setDownloadFileIds] = useState(null);
  const [requestedFileId, setRequestedFileId] = useState(null);
  const [mapSeason, setMapSeason] = useState(1);
  const [mapEpisode, setMapEpisode] = useState(1);
  const requestId = useRef(0);

  const refresh = useCallback(async (nextPage = 1, fresh = false) => {
    const currentRequest = ++requestId.current;
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ provider: filter, page: String(nextPage), fresh: fresh ? "1" : "0" });
      const result = await json(await fetch(`/api/debrid/library?${params}`, { cache: "no-store" }));
      if (currentRequest !== requestId.current) return;
      setProviders(result.providers);
      setItems((current) => nextPage === 1 ? result.items : [...current, ...result.items]);
      setPage(nextPage);
    } catch (loadError) { if (currentRequest === requestId.current) setError(loadError.message); }
    finally { if (currentRequest === requestId.current) setLoading(false); }
  }, [filter]);

  useEffect(() => {
    const timer = setTimeout(() => { void refresh(1, true); }, 0);
    return () => clearTimeout(timer);
  }, [refresh]);

  useEffect(() => {
    if (!items.some((item) => active.has(item.status))) return undefined;
    const timer = setTimeout(() => { void refresh(1, true); }, 20_000);
    return () => clearTimeout(timer);
  }, [items, refresh]);

  useEffect(() => {
    if (!selected || !active.has(selected.status)) return undefined;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const next = await json(await fetch(`/api/debrid/library/${selected.provider}/${encodeURIComponent(selected.resourceId)}`,
          { cache: "no-store" }));
        if (!cancelled) setSelected(next);
      } catch (pollError) { if (!cancelled) setError(pollError.message); }
    }, 20_000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [selected]);

  useEffect(() => () => {
    if (session?.id) void releaseTorrentSession(session.id).catch(() => {});
  }, [session?.id]);

  async function open(item) {
    setError("");
    try {
      const detail = await json(await fetch(`/api/debrid/library/${item.provider}/${encodeURIComponent(item.resourceId)}`,
        { cache: "no-store" }));
      setSelected(detail);
      setDownloadFileIds(null);
      setRequestedFileId(null);
      setMapSeason(detail.mediaContext?.season ?? 1);
      setMapEpisode(detail.mediaContext?.episode ?? 1);
    } catch (openError) { setError(openError.message); }
  }

  async function play(file) {
    if (!selected) return;
    setError("");
    try {
      if (session?.id) await releaseTorrentSession(session.id, { explicit: true });
      const response = await fetch(`/api/debrid/library/${selected.provider}/${encodeURIComponent(selected.resourceId)}/play`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileId: file.providerId }),
      });
      const next = await json(response);
      setSession(next);
      setPlayingFile(next.files.find((entry) => entry.name === file.name) || null);
    } catch (playError) { setError(playError.message); }
  }

  async function confirmFiles() {
    if (!selected) return;
    try {
      const next = await json(await fetch(`/api/debrid/library/${selected.provider}/${encodeURIComponent(selected.resourceId)}/select`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileIds: downloadFileIds || selected.suggestedSelectionIds,
          episodeFileId: requestedFileId }),
      }));
      setSelected(next);
      setError("");
    } catch (selectionError) { setError(selectionError.message); }
  }

  async function mapFile(file) {
    if (!selected) return;
    try {
      const next = await json(await fetch(`/api/debrid/library/${selected.provider}/${encodeURIComponent(selected.resourceId)}/episode-file`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileId: file.providerId, season: mapSeason, episode: mapEpisode }),
      }));
      setSelected(next);
      setError("");
    } catch (mappingError) { setError(mappingError.message); }
  }

  async function remove(item) {
    if (!window.confirm(`Delete “${item.name}” from your ${label[item.provider]} account? This also cancels an active download.`)) return;
    setError("");
    try {
      const response = await fetch(`/api/debrid/library/${item.provider}/${encodeURIComponent(item.resourceId)}`,
        { method: "DELETE" });
      if (!response.ok) await json(response);
      if (selected?.provider === item.provider && selected?.resourceId === item.resourceId) {
        setSelected(null);
        setSession(null);
      }
      await refresh(1, true);
    } catch (deleteError) { setError(deleteError.message); }
  }

  const disconnected = providers.filter((entry) => entry.disconnected);
  const connected = providers.filter((entry) => !entry.disconnected && !entry.error);
  const failed = providers.filter((entry) => entry.error);

  return <section className="debridLibrary">
    <div className="debridLibraryHeading">
      <span className="eyebrow">Your provider accounts</span>
      <h1>Debrid Library</h1>
      <p>Find downloads saved to Real-Debrid and TorBox. Downloads continue when you leave TorPlay.</p>
    </div>
    <div className="debridLibraryToolbar">
      <div className="debridLibraryFilters" role="group" aria-label="Filter by provider">
        {["all", "real-debrid", "torbox"].map((value) => <button type="button" key={value}
          className={filter === value ? "active" : ""} aria-pressed={filter === value}
          onClick={() => {
            if (value === filter) return;
            requestId.current += 1;
            setSelected(null);
            setItems([]);
            setProviders([]);
            setFilter(value);
          }}>
          {value === "all" ? "All downloads" : label[value]}
        </button>)}
      </div>
      <button className="debridLibraryRefresh" type="button" disabled={loading}
        onClick={() => void refresh(1, true)}>{loading ? "Refreshing…" : "Refresh"}</button>
    </div>
    {error ? <div className="notice error" role="alert">{error}</div> : null}
    {failed.map((entry) => <div className="notice error" key={entry.provider} role="alert">
      {label[entry.provider]}: {entry.error}
    </div>)}
    {disconnected.length > 0 && (items.length > 0 || connected.length === 0) ? <div className="debridLibraryConnection" role="status">
      <div>
        <strong>{disconnected.map((entry) => label[entry.provider]).join(" and ")} {disconnected.length === 1 ? "is" : "are"} not connected</strong>
        <p>Connect {disconnected.length === 1 ? "this provider" : "a provider"} to see its downloads here.</p>
      </div>
      <Link href="/settings#services">Connect in Settings →</Link>
    </div> : null}
    {loading && !items.length ? <div className="debridLibraryEmpty" role="status">Loading your downloads…</div> : null}
    {!loading && !items.length && connected.length > 0 && !error ? <div className="debridLibraryEmpty">
      <strong>No downloads yet</strong>
      <p>Downloads from your connected {connected.length === 1 ? "provider" : "providers"} will appear here.</p>
      {disconnected.length > 0 ? <p>{disconnected.map((entry) => label[entry.provider]).join(" and ")} {disconnected.length === 1 ? "is" : "are"} not connected. <Link href="/settings#services">Connect in Settings →</Link></p> : null}
    </div> : null}
    <div className="debridLibraryGrid">
      {items.map((item) => <article className="panel debridLibraryCard" key={`${item.provider}:${item.resourceId}`}>
        <span className="eyebrow">{label[item.provider]} · {item.ownership === "external" ? "Provider account item" : "Added by TorPlay"}</span>
        <h2>{item.name}</h2>
        <p>{item.status}{item.progress != null ? ` · ${Math.round(item.progress * 100)}%` : ""}
          {item.size ? ` · ${formatFileSize(item.size)}` : ""}</p>
        {item.progress != null && item.status !== "ready" ? <progress max={1} value={item.progress} /> : null}
        <div className="debridLibraryActions">
          <button className="debridLibraryOpen" type="button" onClick={() => void open(item)}>View files</button>
          <button className="debridLibraryDelete" type="button" onClick={() => void remove(item)}>{active.has(item.status) ? "Cancel and delete" : "Delete"}</button>
        </div>
      </article>)}
    </div>
    {providers.some((entry) => entry.hasMore) ? <button className="debridLibraryMore" type="button" disabled={loading}
      onClick={() => void refresh(page + 1)}>Load more</button> : null}
    {selected ? <section className="panel debridLibraryDetail">
      <h2>{selected.name}</h2>
      <p>{label[selected.provider]} · {selected.status}</p>
      {selected.status === "awaiting-selection" ? <div className="debridFileReview">
        <strong>Review video files before Real-Debrid downloads them</strong>
        <p>Select the pack files you want and identify the requested episode.</p>
        {selected.files.filter((file) => selected.suggestedSelectionIds.includes(file.providerId)).map((file) => {
          const checked = (downloadFileIds || selected.suggestedSelectionIds).includes(file.providerId);
          return <div className="debridFileReviewRow" key={file.providerId}>
            <label><input type="checkbox" checked={checked} onChange={() => setDownloadFileIds((current) => {
              const ids = current || selected.suggestedSelectionIds;
              return checked ? ids.filter((id) => id !== file.providerId) : [...ids, file.providerId];
            })} /> {file.path} · {formatFileSize(file.size)}</label>
            <label><input type="radio" name="library-requested-episode" checked={requestedFileId === file.providerId}
              onChange={() => setRequestedFileId(file.providerId)} /> Requested episode</label>
          </div>;
        })}
        <button className="primaryButton compact" type="button"
          disabled={!requestedFileId || !(downloadFileIds || selected.suggestedSelectionIds).includes(requestedFileId)}
          onClick={() => void confirmFiles()}>Confirm and download</button>
      </div> : null}
      {selected.mediaContext?.type === "show" ? <div className="debridFileReviewRow">
        <label>Map season <input type="number" min="0" value={mapSeason}
          onChange={(event) => setMapSeason(Number(event.target.value))} /></label>
        <label>Episode <input type="number" min="1" value={mapEpisode}
          onChange={(event) => setMapEpisode(Number(event.target.value))} /></label>
      </div> : null}
      {selected.files.length ? selected.files.map((file) => <div className="debridLibraryFile" key={file.providerId}>
        <span>{file.name} · {formatFileSize(file.size)}
          {selected.episodeMappings?.filter((entry) => entry.fileId === file.providerId)
            .map((entry) => ` · mapped S${String(entry.season).padStart(2, "0")}E${String(entry.episode).padStart(2, "0")}`)
            .join("") || (selected.mediaContext?.type === "show" ? " · unmapped" : "")}
        </span>
        {selected.mediaContext?.type === "show" ? <button type="button" onClick={() => void mapFile(file)}>Map to episode</button> : null}
        {selected.status === "ready" && file.selected ? <button className="primaryButton compact" type="button" onClick={() => void play(file)}>Play</button> : null}
      </div>) : <p>File details are not available yet.</p>}
      {session && playingFile ? <div className="videoFrame"><VideoPlayer key={`${session.id}:${playingFile.id}`}
        sessionId={session.id} file={playingFile} title={selected.name}
        profileId={activeProfile?.id} media={historyMedia(selected, selected.files.find((file) => file.name === playingFile.name) || {})} />
      </div> : null}
    </section> : null}
  </section>;
}
