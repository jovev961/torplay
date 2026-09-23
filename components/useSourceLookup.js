"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isRemotePlaybackSessionActive } from "../lib/remote-playback/client-state.js";

async function readJson(response) {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    throw new Error(`The server returned an unexpected response (${response.status}).`);
  }
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || "The request failed.");
    error.code = data.code || null;
    throw error;
  }
  return data;
}

export async function releaseTorrentSession(
  sessionId,
  {
    explicit = false,
    fetchImpl = globalThis.fetch,
    navigatorImpl = globalThis.navigator,
    preferBeacon = false,
  } = {},
) {
  if (!sessionId) return false;
  const baseUrl = `/api/torrents/${encodeURIComponent(sessionId)}`;
  const releaseUrl = `${baseUrl}/release`;

  if (preferBeacon && navigatorImpl?.sendBeacon?.(releaseUrl)) return true;
  if (typeof fetchImpl !== "function") return false;

  const response = await fetchImpl(explicit ? baseUrl : releaseUrl, {
    method: explicit ? "DELETE" : "POST",
    keepalive: true,
  });
  if (!response.ok) throw new Error("The temporary torrent could not be cleaned up.");
  return true;
}

export function shouldPollTorrentSession(session) {
  return torrentSessionPollDelay(session) !== null;
}

export function torrentSessionPollDelay(session) {
  if (!session?.id) return null;
  if (session.status === "loading") return 1000;
  if (session.status === "ready") return 2000;
  return null;
}

export function useSourceLookup() {
  const [results, setResults] = useState([]);
  const [usenetResults, setUsenetResults] = useState([]);
  const [usenetJobs, setUsenetJobs] = useState([]);
  const [usenetJob, setUsenetJob] = useState(null);
  const [usenetEnabled, setUsenetEnabled] = useState(false);
  const [usenetPollFailures, setUsenetPollFailures] = useState(0);
  const [mediaContext, setMediaContext] = useState(null);
  const [searching, setSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [startingId, setStartingId] = useState(null);
  const [session, setSession] = useState(null);
  const [selectedFileId, setSelectedFileId] = useState(null);
  const [error, setError] = useState("");
  const [errorCode, setErrorCode] = useState("");
  const pendingRequests = useRef(new Set());
  const releasedSessionIds = useRef(new Set());

  const request = useCallback(async (url, options = {}) => {
    const controller = new AbortController();
    pendingRequests.current.add(controller);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      pendingRequests.current.delete(controller);
    }
  }, []);

  const releaseSession = useCallback(async (sessionId, options = {}) => {
    if (!sessionId || releasedSessionIds.current.has(sessionId)) return true;
    releasedSessionIds.current.add(sessionId);
    try {
      return await releaseTorrentSession(sessionId, options);
    } catch (releaseError) {
      releasedSessionIds.current.delete(sessionId);
      throw releaseError;
    }
  }, []);

  useEffect(() => () => {
    for (const controller of pendingRequests.current) controller.abort();
    pendingRequests.current.clear();
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/settings/usenet", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : null)
      .then((data) => { if (!cancelled) setUsenetEnabled(data?.enabled === true); })
      .catch(() => {});
    void fetch("/api/usenet/jobs", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : { jobs: [] })
      .then((data) => { if (!cancelled) setUsenetJobs(data.jobs || []); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!usenetJob?.id || ["ready", "failed", "cancelled", "timed-out"].includes(usenetJob.status)) return undefined;
    const age = Date.now() - (usenetJob.createdAt || Date.now());
    let cancelled = false;
    const timer = setTimeout(async () => {
      if (Date.now() - usenetJob.createdAt > 2 * 60 * 60 * 1000) {
        if (!cancelled) setUsenetJob((current) => ({ ...current, status: "timed-out" }));
        return;
      }
      try {
        const next = await readJson(await fetch(`/api/usenet/jobs/${encodeURIComponent(usenetJob.id)}`, { cache: "no-store" }));
        if (cancelled) return;
        setUsenetPollFailures(0);
        setError("");
        setUsenetJob(next);
        if (next.status === "ready" && !session) {
          const playback = await readJson(await fetch(`/api/usenet/jobs/${encodeURIComponent(next.id)}`, { method: "POST" }));
          if (!cancelled) setSession(playback);
        }
      } catch (pollError) {
        if (!cancelled) {
          setError(pollError.message);
          setUsenetPollFailures((current) => Math.min(current + 1, 5));
        }
      }
    }, age > 2 * 60 * 60 * 1000 ? 0 : Math.min(60_000,
      (age < 2 * 60_000 ? 5_000 : age < 15 * 60_000 ? 15_000 : 30_000)
      * 2 ** usenetPollFailures));
    return () => { cancelled = true; clearTimeout(timer); };
  }, [usenetJob, session, usenetPollFailures]);

  useEffect(() => {
    const pollDelay = torrentSessionPollDelay(session);
    if (pollDelay === null) return undefined;

    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/torrents/${encodeURIComponent(session.id)}`, {
          cache: "no-store",
        });
        const next = await readJson(response);
        if (!cancelled) setSession(next);
      } catch (pollError) {
        if (!cancelled) {
          setError(pollError.message);
          setErrorCode(pollError.code || "");
        }
      }
    }, pollDelay);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [session]);

  useEffect(() => {
    const sessionId = session?.id;
    if (!sessionId) return undefined;

    const onPageHide = () => {
      if (isRemotePlaybackSessionActive(sessionId)) return;
      void releaseSession(sessionId, { preferBeacon: true }).catch(() => {});
    };
    const onPageShow = (event) => {
      if (!event.persisted) return;
      setSession((current) => current?.id === sessionId ? null : current);
      setSelectedFileId(null);
    };

    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      if (!isRemotePlaybackSessionActive(sessionId)) {
        void releaseSession(sessionId).catch(() => {});
      }
    };
  }, [releaseSession, session?.id]);

  async function stop() {
    if (!session?.id) return;
    try {
      await releaseSession(session.id, { explicit: true });
    } catch (stopError) {
      setError(stopError.message);
      setErrorCode(stopError.code || "");
    } finally {
      setSession(null);
      setSelectedFileId(null);
    }
  }

  async function search(criteria) {
    if (session?.id) await stop();
    setSearching(true);
    setHasSearched(true);
    setError("");
    setErrorCode("");
    setResults([]);
    setUsenetResults([]);
    setMediaContext(criteria);
    setSelectedFileId(null);

    const params = new URLSearchParams({ type: criteria.type, q: criteria.query });
    if (criteria.season !== undefined) params.set("season", String(criteria.season));
    if (criteria.episode !== undefined) params.set("episode", String(criteria.episode));
    if (criteria.tmdbId !== undefined) params.set("tmdbId", String(criteria.tmdbId));
    if (criteria.imdbId) params.set("imdbId", criteria.imdbId);
    if (criteria.year) params.set("year", String(criteria.year));

    try {
      const response = await request(`/api/search?${params}`, { cache: "no-store" });
      const data = await readJson(response);
      setResults(data.results);
      setUsenetResults(data.usenetResults || []);
    } catch (searchError) {
      if (searchError.name !== "AbortError") {
        setError(searchError.message);
        setErrorCode(searchError.code || "");
      }
    } finally {
      setSearching(false);
    }
  }

  async function startUsenet(resultId) {
    setStartingId(resultId);
    setError("");
    try {
      const job = await readJson(await request("/api/usenet/jobs", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resultId }),
      }));
      setUsenetJob(job);
      setUsenetPollFailures(0);
      setUsenetJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
      if (job.status === "ready") setSession(await readJson(await request(`/api/usenet/jobs/${encodeURIComponent(job.id)}`, { method: "POST" })));
    } catch (startError) { setError(startError.message); }
    finally { setStartingId(null); }
  }

  async function uploadNzb(file) {
    setStartingId("upload");
    setError("");
    try {
      const form = new FormData();
      form.set("file", file);
      if (mediaContext) form.set("mediaContext", JSON.stringify(mediaContext));
      const job = await readJson(await request("/api/usenet/jobs", { method: "POST", body: form }));
      setUsenetJob(job);
      setUsenetPollFailures(0);
      setUsenetJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
      if (job.status === "ready") setSession(await readJson(await request(`/api/usenet/jobs/${encodeURIComponent(job.id)}`, { method: "POST" })));
    } catch (uploadError) { setError(uploadError.message); }
    finally { setStartingId(null); }
  }

  async function resumeUsenet(id) {
    try {
      const next = await readJson(await request(`/api/usenet/jobs/${encodeURIComponent(id)}`, { cache: "no-store" }));
      setUsenetJob(next);
      setUsenetPollFailures(0);
      if (next.status === "ready") {
        setSession(await readJson(await request(`/api/usenet/jobs/${encodeURIComponent(id)}`, { method: "POST" })));
      }
    } catch (resumeError) { setError(resumeError.message); }
  }

  async function deleteUsenet(id) {
    try {
      await request(`/api/usenet/jobs/${encodeURIComponent(id)}`, { method: "DELETE" });
      setUsenetJobs((current) => current.filter((item) => item.id !== id));
      if (usenetJob?.id === id) { setUsenetJob(null); setSession(null); }
    } catch (deleteError) { setError(deleteError.message); }
  }

  async function start(resultId) {
    setStartingId(resultId);
    setError("");
    setErrorCode("");
    setSelectedFileId(null);
    try {
      const response = await request("/api/torrents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resultId }),
      });
      setSession(await readJson(response));
    } catch (startError) {
      if (startError.name !== "AbortError") {
        setError(startError.message);
        setErrorCode(startError.code || "");
      }
    } finally {
      setStartingId(null);
    }
  }

  function adoptSession(nextSession, fileId = null) {
    setError("");
    setErrorCode("");
    setResults([]);
    setHasSearched(true);
    setSession(nextSession);
    setSelectedFileId(fileId);
  }

  return {
    error,
    errorCode,
    hasSearched,
    results,
    usenetResults,
    usenetJobs,
    usenetJob,
    usenetEnabled,
    searching,
    selectedFileId,
    session,
    startingId,
    search,
    adoptSession,
    setSelectedFileId,
    start,
    startUsenet,
    uploadNzb,
    resumeUsenet,
    deleteUsenet,
    stop,
  };
}
