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
  return Boolean(session?.id && session.status === "loading");
}

export function useSourceLookup() {
  const [results, setResults] = useState([]);
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
    if (!shouldPollTorrentSession(session)) return undefined;

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
    }, 1000);

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
    } catch (searchError) {
      if (searchError.name !== "AbortError") {
        setError(searchError.message);
        setErrorCode(searchError.code || "");
      }
    } finally {
      setSearching(false);
    }
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
    searching,
    selectedFileId,
    session,
    startingId,
    search,
    adoptSession,
    setSelectedFileId,
    start,
    stop,
  };
}
