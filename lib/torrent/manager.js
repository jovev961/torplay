import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import parseTorrent from "parse-torrent";
import WebTorrent from "webtorrent";
import { cleanupSubtitleCache } from "../subtitles/cache.js";
import {
  findEpisodeFile,
  findLargestFile,
  safeTorrentRelativePath,
} from "../video/episode.js";
import { resolveEpisodeFile } from "../video/episode-mapping.js";
import {
  classifySubtitleFile,
  subtitleMatchesVideo,
  subtitleMetadata,
} from "../video/subtitles.js";

export const TORRENT_SESSION_IDLE_TTL_MS = 2 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 1000;
export const SUBTITLE_CACHE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const TORRENT_VALIDATION_FETCH_TIMEOUT_MS = 8_000;
const TORRENT_START_FETCH_TIMEOUT_MS = 30_000;
const TORRENT_METADATA_TIMEOUT_MS = 120_000;
const MAX_TORRENT_FILE_BYTES = 5 * 1024 * 1024;
export const DEFAULT_TORRENT_TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "https://tracker.opentrackr.org:443/announce",
  "udp://tracker.torrent.eu.org:451/announce",
];
const TRACKER_PROTOCOLS = new Set(["udp:", "http:", "https:", "ws:", "wss:"]);
const NATIVE_VIDEO_TYPES = new Map([
  [".mp4", "video/mp4"],
  [".m4v", "video/mp4"],
  [".webm", "video/webm"],
]);
const TRANSCODE_VIDEO_TYPES = new Set([
  ".3g2",
  ".3gp",
  ".avi",
  ".divx",
  ".flv",
  ".m2ts",
  ".mkv",
  ".mov",
  ".mpg",
  ".mpeg",
  ".mts",
  ".ogm",
  ".ogv",
  ".ts",
  ".vob",
  ".wmv",
]);
const stateKey = Symbol.for("torplay.torrentState");

function getState() {
  if (!globalThis[stateKey]) {
    globalThis[stateKey] = {
      client: null,
      sessions: new Map(),
      resources: new Map(),
      resourceStarts: new Map(),
      mediaServer: null,
      mediaServerReady: null,
      storageReady: null,
      cleanupTimer: null,
      lastSubtitleCleanupAt: 0,
    };
  }
  globalThis[stateKey].resources ??= new Map();
  globalThis[stateKey].resourceStarts ??= new Map();
  globalThis[stateKey].mediaServer ??= null;
  globalThis[stateKey].mediaServerReady ??= null;
  globalThis[stateKey].lastSubtitleCleanupAt ??= 0;
  return globalThis[stateKey];
}

export function parseTorrentTrackers(value = process.env.TORRENT_TRACKERS) {
  const configured = String(value ?? "").trim();
  if (!configured) return [...DEFAULT_TORRENT_TRACKERS];
  if (configured.toLowerCase() === "none") return [];

  const trackers = [...new Set(
    configured
      .split(",")
      .map((tracker) => tracker.trim())
      .filter(Boolean),
  )];
  for (const tracker of trackers) {
    let url;
    try {
      url = new URL(tracker);
    } catch {
      throw new Error("TORRENT_TRACKERS contains an invalid tracker URL.");
    }
    if (!TRACKER_PROTOCOLS.has(url.protocol) || !url.hostname) {
      throw new Error("TORRENT_TRACKERS contains an unsupported tracker URL.");
    }
  }
  return trackers;
}

function downloadRoot() {
  const configured = process.env.TORRENT_DOWNLOAD_PATH?.trim() || ".data/torrents";
  return path.resolve(/* turbopackIgnore: true */ process.cwd(), configured);
}

async function prepareStorage() {
  const root = downloadRoot();
  await mkdir(root, { recursive: true });

  const entries = await readdir(/* turbopackIgnore: true */ root, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(entry.name))
      .map((entry) =>
        rm(path.join(/* turbopackIgnore: true */ root, entry.name), { recursive: true, force: true }),
      ),
  );
}

function ensureCleanupTimer(state) {
  if (state.cleanupTimer) return;

  state.lastSubtitleCleanupAt = Date.now();
  void cleanupSubtitleCacheForSessions(state.lastSubtitleCleanupAt).then(reportSubtitleCleanup);
  state.cleanupTimer = setInterval(() => {
    const now = Date.now();
    void cleanupIdleTorrentSessions(now).catch((error) => {
      console.error("Could not clean up idle torrent sessions:", error.message);
    });
    if (now - state.lastSubtitleCleanupAt >= SUBTITLE_CACHE_CLEANUP_INTERVAL_MS) {
      state.lastSubtitleCleanupAt = now;
      void cleanupSubtitleCacheForSessions(now).then(reportSubtitleCleanup);
    }
  }, CLEANUP_INTERVAL_MS);
  state.cleanupTimer.unref?.();
}

function stopCleanupTimer(state) {
  if (!state.cleanupTimer) return;
  clearInterval(state.cleanupTimer);
  state.cleanupTimer = null;
}

export async function shutdownIdleTorrentRuntime() {
  const state = getState();
  if (state.sessions.size || state.resources.size || state.resourceStarts.size) return false;

  stopCleanupTimer(state);
  state.lastSubtitleCleanupAt = 0;
  const client = state.client;
  state.client = null;
  state.mediaServer = null;
  state.mediaServerReady = null;
  if (!client || client.destroyed || typeof client.destroy !== "function") return true;

  try {
    await new Promise((resolve) => {
      client.destroy((error) => {
        if (error) console.error("Could not stop the idle torrent client:", error.message);
        resolve();
      });
    });
  } catch (error) {
    console.error("Could not stop the idle torrent client:", error.message);
  }
  return true;
}

function subtitleCachePathInUse(state, filename) {
  for (const session of state.sessions.values()) {
    for (const discovery of session.subtitleDiscoveries?.values() || []) {
      if (discovery.cachePaths?.has(filename)) return true;
    }
  }
  return false;
}

function reportSubtitleCleanup(result) {
  if (!result?.failures?.length) return;
  console.error(`Could not clean up ${result.failures.length} subtitle cache entr${result.failures.length === 1 ? "y" : "ies"}.`);
}

export async function cleanupSubtitleCacheForSessions(now = Date.now(), dependencies = {}) {
  const state = getState();
  const cleanup = dependencies.cleanupSubtitleCache || cleanupSubtitleCache;
  try {
    return await cleanup({
      now,
      isProtected: (filename) => subtitleCachePathInUse(state, filename),
    });
  } catch (error) {
    return {
      removedFiles: 0,
      removedDirectories: 0,
      failures: [{ path: null, message: error.message || "Subtitle cache cleanup failed." }],
    };
  }
}

export async function cleanupIdleTorrentSessions(now = Date.now()) {
  const state = getState();
  const cutoff = now - TORRENT_SESSION_IDLE_TTL_MS;
  const expiredIds = [...state.sessions.values()]
    .filter((session) => session.streams === 0 && session.lastActivity < cutoff)
    .map((session) => session.id);

  await Promise.all(expiredIds.map((id) => stopTorrent(id)));
  return expiredIds.length;
}

async function getClient() {
  const state = getState();
  if (!state.storageReady) {
    state.storageReady = prepareStorage();
  }
  await state.storageReady;

  if (!state.client || state.client.destroyed) {
    state.client = new WebTorrent({
      tracker: { announce: parseTorrentTrackers() },
    });
    state.client.on("error", (error) => {
      console.error("Torrent client error:", error.message);
    });
    state.mediaServer = null;
    state.mediaServerReady = null;
  }
  if (!state.mediaServer) {
    state.mediaServer = state.client._server || state.client.createServer({
      hostname: "127.0.0.1",
      pathname: `/torplay-${randomUUID()}`,
    });
    if (state.mediaServer.address()) {
      state.mediaServerReady = Promise.resolve();
    } else {
      state.mediaServerReady = new Promise((resolve, reject) => {
        state.mediaServer.server.once("error", reject);
        state.mediaServer.listen(0, "127.0.0.1", () => {
          state.mediaServer.server.removeListener("error", reject);
          resolve();
        });
      });
    }
  }

  await state.mediaServerReady;

  ensureCleanupTimer(state);
  return state.client;
}

async function parseTorrentMetadata(input) {
  let parsed;
  try {
    parsed = await parseTorrent(input);
  } catch {
    throw new Error("The selected result does not contain valid torrent metadata.");
  }

  if (!parsed?.infoHash) {
    throw new Error("The selected result does not contain a valid torrent info hash.");
  }
  return parsed;
}

export async function validateTorrentInput(input) {
  const parsed = await parseTorrentMetadata(input);
  return parsed.infoHash.toLowerCase();
}

async function readLimitedBody(response) {
  const declaredLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_TORRENT_FILE_BYTES) {
    throw new Error("The torrent metadata file is too large.");
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("The torrent provider returned an empty response.");

  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_TORRENT_FILE_BYTES) {
      await reader.cancel();
      throw new Error("The torrent metadata file is too large.");
    }
    chunks.push(value);
  }

  const buffer = Buffer.allocUnsafe(length);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return buffer;
}

async function fetchTorrentFile(rawUrl, timeoutMs) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("The provider returned an invalid torrent URL.");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Torrent downloads must use HTTP or HTTPS.");
  }

  let response;
  try {
    response = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error?.name === "TimeoutError") throw new Error("The torrent download timed out.");
    throw new Error("Could not download torrent metadata from the provider.");
  }
  if (!response.ok) {
    throw new Error(`The torrent provider returned HTTP ${response.status}.`);
  }

  return readLimitedBody(response);
}

async function resolveProviderSource(source) {
  if (typeof source?.resolver !== "function") return false;
  const resolved = await source.resolver();
  if (!resolved || typeof resolved !== "object") {
    throw new Error("The provider could not resolve torrent metadata.");
  }
  Object.assign(source, resolved);
  source.resolver = null;
  return true;
}

async function validatedTorrentFile(source, timeoutMs) {
  const input = await fetchTorrentFile(source.downloadUrl, timeoutMs);
  const infoHash = await validateTorrentInput(input);
  source.torrentInput = input;
  return { input, infoHash, metadataSource: "torrent" };
}

export async function resolveTorrentInput(source) {
  if (Buffer.isBuffer(source?.torrentInput)) {
    const infoHash = await validateTorrentInput(source.torrentInput);
    return { input: source.torrentInput, infoHash, metadataSource: "torrent" };
  }

  let downloadError = null;
  let resolverError = null;
  let attemptedDownloadUrl = null;
  if (source?.downloadUrl) {
    attemptedDownloadUrl = source.downloadUrl;
    try {
      return await validatedTorrentFile(source, TORRENT_START_FETCH_TIMEOUT_MS);
    } catch (error) {
      downloadError = error;
    }
  }

  if (typeof source?.resolver === "function") {
    try {
      await resolveProviderSource(source);
      if (Buffer.isBuffer(source.torrentInput)) {
        const infoHash = await validateTorrentInput(source.torrentInput);
        return { input: source.torrentInput, infoHash, metadataSource: "torrent" };
      }
      if (source.downloadUrl && source.downloadUrl !== attemptedDownloadUrl) {
        try {
          return await validatedTorrentFile(source, TORRENT_START_FETCH_TIMEOUT_MS);
        } catch (error) {
          downloadError = error;
        }
      }
    } catch (error) {
      resolverError = error;
    }
  }

  if (source?.magnet) {
    const infoHash = await validateTorrentInput(source.magnet);
    return { input: source.magnet, infoHash, metadataSource: "magnet" };
  }
  if (resolverError) throw resolverError;
  if (downloadError) throw downloadError;
  throw new Error("This search result has no usable magnet or torrent file.");
}

export function classifyVideoFile(name) {
  const extension = path.extname(typeof name === "string" ? name : "").toLowerCase();
  const nativeMimeType = NATIVE_VIDEO_TYPES.get(extension);
  if (nativeMimeType) return { mimeType: nativeMimeType, playbackMode: "native" };
  if (TRANSCODE_VIDEO_TYPES.has(extension)) {
    return { mimeType: "video/mp4", playbackMode: "transcode" };
  }
  return null;
}

async function inspectTorrentInput(input, context) {
  const parsed = await parseTorrentMetadata(input);
  const videos = (parsed.files ?? []).flatMap((file) => {
    const video = classifyVideoFile(file.name);
    if (!video) return [];
    return [{
      name: file.name,
      path: safeTorrentRelativePath(file.path, file.name),
      size: file.length,
      ...video,
    }];
  });

  const selected = context.type === "show"
    ? resolveEpisodeFile(parsed.infoHash?.toLowerCase(), context, videos)
    : findLargestFile(videos);
  if (selected) return { playbackMode: selected.playbackMode };
  return context.type === "show" && videos.length > 1
    ? { playbackMode: null, manualSelectionRequired: true } : null;
}

export async function inspectTorrentSource(source, context = {}) {
  if (Buffer.isBuffer(source?.torrentInput)) {
    return inspectTorrentInput(source.torrentInput, context);
  }

  const attemptedDownloadUrl = source?.downloadUrl || null;
  if (attemptedDownloadUrl) {
    try {
      const input = await fetchTorrentFile(attemptedDownloadUrl, TORRENT_VALIDATION_FETCH_TIMEOUT_MS);
      const inspection = await inspectTorrentInput(input, context);
      if (inspection) source.torrentInput = input;
      return inspection;
    } catch (error) {
      if (typeof source.resolver !== "function") throw error;
      await resolveProviderSource(source);
      if (Buffer.isBuffer(source.torrentInput)) return inspectTorrentInput(source.torrentInput, context);
      if (!source.downloadUrl || source.downloadUrl === attemptedDownloadUrl) throw error;
    }
  } else if (typeof source?.resolver === "function") {
    await resolveProviderSource(source);
    if (Buffer.isBuffer(source.torrentInput)) return inspectTorrentInput(source.torrentInput, context);
  }

  if (!source?.downloadUrl) return null;
  const input = await fetchTorrentFile(source.downloadUrl, TORRENT_VALIDATION_FETCH_TIMEOUT_MS);
  const inspection = await inspectTorrentInput(input, context);
  if (!inspection) return null;

  source.torrentInput = input;
  return inspection;
}

export function listPublicVideoFiles(session) {
  const torrent = session.resource?.torrent;
  if (!torrent) return [];
  const videoFiles = torrent.files.flatMap((file, index) => {
    const video = classifyVideoFile(file.name);
    if (!video) return [];
    return [{ file, index, video }];
  });
  const subtitleFiles = torrent.files.flatMap((file, index) => {
    const subtitle = classifySubtitleFile(file.name);
    if (!subtitle) return [];
    return [{ file, index, subtitle }];
  });

  return videoFiles.map(({ file, index, video }) => {
    const downloaded = Math.max(0, Math.min(file.downloaded, file.length));
    const subtitles = subtitleFiles
      .filter((candidate) => subtitleMatchesVideo(file, candidate.file, videoFiles.length))
      .map(({ file: subtitleFile, index: subtitleIndex, subtitle }) => ({
        id: String(subtitleIndex),
        name: subtitleFile.name,
        size: subtitleFile.length,
        format: subtitle.format,
        ...subtitleMetadata(subtitleFile.name),
        src: `/api/torrents/${encodeURIComponent(session.id)}/subtitles/${subtitleIndex}`,
      }));
    return {
      id: String(index),
      name: file.name,
      relativePath: safeTorrentRelativePath(file.path, file.name),
      size: file.length,
      ...video,
      subtitles,
      downloaded,
      progress: file.length ? downloaded / file.length : 0,
      buffering: session.selectedFileId === String(index),
    };
  });
}

function toPublicSession(session) {
  const resource = session.resource;
  const torrent = resource.torrent;
  const files = resource.status === "ready" ? listPublicVideoFiles(session) : [];
  const mapped = resource.status === "ready" && session.mediaContext?.type === "show"
    ? resolveEpisodeFile(session.infoHash, session.mediaContext, files) : null;
  return {
    id: session.id,
    status: resource.status,
    name: torrent?.name || null,
    peers: torrent?.numPeers ?? 0,
    downloadSpeed: torrent?.downloadSpeed ?? 0,
    discovery: {
      trackerCount: torrent?.announce?.length ?? 0,
      trackerAnnounces: resource.discovery.trackerAnnounces,
      dhtAnnounced: resource.discovery.dhtAnnounced,
      warnings: resource.discovery.warnings,
      noPeerSources: [...resource.discovery.noPeerSources],
    },
    files,
    suggestedFileId: mapped?.id || null,
    error: resource.error,
  };
}

function clearMetadataTimer(resource) {
  if (!resource.metadataTimer) return;
  clearTimeout(resource.metadataTimer);
  resource.metadataTimer = null;
}

async function removeTorrentResource(resource) {
  clearMetadataTimer(resource);
  const state = getState();
  if (state.resources.get(resource.infoHash) === resource) {
    state.resources.delete(resource.infoHash);
  }
  const torrent = resource.torrent;
  resource.torrent = null;
  if (torrent && !torrent.destroyed) {
    try {
      await state.client?.remove(torrent.infoHash, { destroyStore: true });
    } catch (error) {
      console.error("Could not remove the torrent from WebTorrent:", error.message);
    }
  }

  if (/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(resource.infoHash)) {
    try {
      await rm(path.join(downloadRoot(), resource.infoHash), { recursive: true, force: true });
    } catch (error) {
      console.error("Could not remove the torrent download directory:", error.message);
    }
  }
}

async function createTorrentResource(input, infoHash) {
  const state = getState();
  const client = await getClient();
  const resource = {
    infoHash,
    torrent: null,
    status: "loading",
    error: null,
    sessions: new Set(),
    pieceRefs: new Map(),
    mediaProbes: new Map(),
    discovery: {
      trackerAnnounces: 0,
      dhtAnnounced: false,
      warnings: 0,
      noPeerSources: new Set(),
    },
    metadataTimer: null,
  };
  state.resources.set(infoHash, resource);

  try {
    const torrent = client.add(input, {
      path: downloadRoot(),
      addUID: true,
      deselect: true,
      destroyStoreOnDestroy: true,
    });
    resource.torrent = torrent;

    torrent.on("trackerAnnounce", () => {
      resource.discovery.trackerAnnounces += 1;
    });
    torrent.on("dhtAnnounce", () => {
      resource.discovery.dhtAnnounced = true;
    });
    torrent.on("warning", () => {
      resource.discovery.warnings += 1;
    });
    torrent.on("noPeers", (source) => {
      resource.discovery.noPeerSources.add(source);
    });
    torrent.on("wire", () => {
      resource.discovery.noPeerSources.clear();
    });

    const markReady = () => {
      if (resource.status !== "loading") return;
      clearMetadataTimer(resource);
      resource.status = "ready";
    };
    torrent.once("ready", markReady);
    torrent.once("error", (error) => {
      if (resource.status !== "loading") return;
      clearMetadataTimer(resource);
      resource.status = "error";
      resource.error = error.message || "The torrent session failed.";
    });
    resource.metadataTimer = setTimeout(() => {
      if (resource.status !== "loading") return;
      resource.status = "error";
      resource.error = "Torrent metadata could not be loaded within 2 minutes. Try another source.";
      void removeTorrentResource(resource);
    }, TORRENT_METADATA_TIMEOUT_MS);
    resource.metadataTimer.unref?.();
    if (torrent.ready) markReady();
    return resource;
  } catch (error) {
    state.resources.delete(infoHash);
    throw new Error(error.message || "Could not start the torrent.");
  }
}

async function getOrCreateTorrentResource(input, infoHash) {
  const state = getState();
  const existing = state.resources.get(infoHash);
  if (existing) return existing;

  const pending = state.resourceStarts.get(infoHash);
  if (pending) return pending;

  const start = createTorrentResource(input, infoHash);
  state.resourceStarts.set(infoHash, start);
  try {
    return await start;
  } finally {
    if (state.resourceStarts.get(infoHash) === start) state.resourceStarts.delete(infoHash);
    await shutdownIdleTorrentRuntime();
  }
}

export async function startTorrent(source) {
  const { input, infoHash } = await resolveTorrentInput(source);
  const state = getState();
  const resource = await getOrCreateTorrentResource(input, infoHash);
  const id = randomUUID();
  const session = {
    id,
    infoHash,
    resource,
    lastActivity: Date.now(),
    streams: 0,
    selectedFileId: null,
    priorityLease: null,
    activeConversion: null,
    subtitleDiscoveries: new Map(),
    mediaContext: source.mediaContext || null,
    releaseName: source.releaseName || null,
  };
  state.sessions.set(id, session);
  resource.sessions.add(id);

  return toPublicSession(session);
}

export function getTorrentSession(id) {
  const session = getState().sessions.get(id);
  if (!session) return null;
  session.lastActivity = Date.now();
  return toPublicSession(session);
}

export function getTorrentMediaContext(id) {
  return getState().sessions.get(id)?.mediaContext || null;
}

export function getTorrentMappingTarget(id) {
  const session = getState().sessions.get(id);
  if (!session || session.resource.status !== "ready") return null;
  return { infoHash: session.infoHash, mediaContext: session.mediaContext,
    files: listPublicVideoFiles(session) };
}

export function updateTorrentMediaContext(id, mediaContext) {
  const session = getState().sessions.get(id);
  if (!session) return false;
  session.mediaContext = mediaContext;
  session.lastActivity = Date.now();
  return true;
}

export function findSessionEpisode(id, season, episode) {
  const session = getState().sessions.get(id);
  if (!session || session.resource.status !== "ready") return null;
  const file = resolveEpisodeFile(session.infoHash, session.mediaContext,
    listPublicVideoFiles(session), season, episode, {
    allowSingleFileFallback: false,
  });
  return file ? { session: toPublicSession(session), file } : null;
}

export function getVideoFile(sessionId, fileId) {
  const session = getState().sessions.get(sessionId);
  if (!session || session.resource.status !== "ready" || !/^\d+$/.test(fileId)) return null;

  const file = session.resource.torrent.files[Number(fileId)];
  const video = file && classifyVideoFile(file.name);
  if (!file || !video) return null;

  session.lastActivity = Date.now();
  return { session, file, ...video };
}

export function getSubtitleFile(sessionId, fileId) {
  const session = getState().sessions.get(sessionId);
  if (!session || session.resource.status !== "ready" || !/^\d+$/.test(fileId)) return null;

  const file = session.resource.torrent.files[Number(fileId)];
  const subtitle = file && classifySubtitleFile(file.name);
  if (!file || !subtitle) return null;

  session.lastActivity = Date.now();
  return { session, file, ...subtitle };
}

function bytePieceRange(resource, file, start, end) {
  if (!file || file.length <= 0) return null;
  const boundedStart = Math.max(0, Math.min(Number(start) || 0, file.length - 1));
  const boundedEnd = Math.max(boundedStart, Math.min(Number(end) || boundedStart, file.length - 1));
  return {
    start: Math.floor((file.offset + boundedStart) / resource.torrent.pieceLength),
    end: Math.floor((file.offset + boundedEnd) / resource.torrent.pieceLength),
  };
}

function updatePieceReferences(resource, range, change) {
  if (!range) return;

  let transitionStart = null;
  let previousTransition = null;
  const flush = () => {
    if (transitionStart === null) return;
    if (change > 0) resource.torrent.select(transitionStart, previousTransition, 0);
    else resource.torrent.deselect(transitionStart, previousTransition);
    transitionStart = null;
    previousTransition = null;
  };

  for (let piece = range.start; piece <= range.end; piece += 1) {
    const previous = resource.pieceRefs.get(piece) || 0;
    const next = Math.max(0, previous + change);
    if (next === 0) resource.pieceRefs.delete(piece);
    else resource.pieceRefs.set(piece, next);

    const transitioned = change > 0 ? previous === 0 && next === 1 : previous === 1 && next === 0;
    if (!transitioned) {
      flush();
    } else if (transitionStart === null) {
      transitionStart = piece;
      previousTransition = piece;
    } else if (piece === previousTransition + 1) {
      previousTransition = piece;
    } else {
      flush();
      transitionStart = piece;
      previousTransition = piece;
    }
  }
  flush();
}

function releaseSelectedFile(session) {
  if (session.priorityLease) updatePieceReferences(session.resource, session.priorityLease, -1);
  session.priorityLease = null;
  session.selectedFileId = null;
}

export function bufferVideoFile(session, file, byteRange = null) {
  const fileId = String(session.resource.torrent.files.indexOf(file));
  if (fileId === "-1") return;

  const defaultEnd = Math.min(file.length - 1, 16 * 1024 * 1024 - 1);
  const requested = bytePieceRange(
    session.resource,
    file,
    byteRange?.start ?? 0,
    byteRange?.end ?? defaultEnd,
  );
  const unchanged = session.selectedFileId === fileId
    && session.priorityLease?.start === requested?.start
    && session.priorityLease?.end === requested?.end;
  if (unchanged) return;

  if (session.selectedFileId !== null) {
    if (session.selectedFileId !== fileId) stopActiveConversion(session);
    releaseSelectedFile(session);
  }
  updatePieceReferences(session.resource, requested, 1);
  session.selectedFileId = fileId;
  session.priorityLease = requested;
  session.lastActivity = Date.now();
}

export function getInternalFileUrl(session, file) {
  const state = getState();
  const address = state.mediaServer?.address();
  if (!address?.port || !file?.streamURL) throw new Error("The internal torrent media server is unavailable.");
  return `http://127.0.0.1:${address.port}${file.streamURL}`;
}

function stopActiveConversion(session) {
  const active = session.activeConversion;
  session.activeConversion = null;
  active?.stop();
}

export function getActiveConversion(session, file) {
  const active = session.activeConversion;
  if (!active || active.file !== file) return null;
  session.lastActivity = Date.now();
  active.touch?.();
  return active;
}

export function stopActiveConversionForFile(session, file) {
  if (session.activeConversion?.file !== file) return false;
  stopActiveConversion(session);
  session.lastActivity = Date.now();
  return true;
}

export function registerActiveConversion(session, file, conversion) {
  stopActiveConversion(session);
  const active = typeof conversion === "function" ? { stop: conversion } : conversion;
  active.file = file;
  session.activeConversion = active;
  session.lastActivity = Date.now();

  return () => {
    if (session.activeConversion === active) session.activeConversion = null;
  };
}

export function beginStream(session) {
  session.streams += 1;
  session.lastActivity = Date.now();
  let ended = false;

  return () => {
    if (ended) return;
    ended = true;
    session.streams = Math.max(0, session.streams - 1);
    session.lastActivity = Date.now();
  };
}

export async function stopTorrent(id) {
  const state = getState();
  const session = state.sessions.get(id);
  if (!session) return false;

  state.sessions.delete(id);
  stopActiveConversion(session);
  releaseSelectedFile(session);
  const resource = session.resource;
  resource.sessions.delete(id);
  if (resource.sessions.size === 0) {
    await removeTorrentResource(resource);
  }
  await shutdownIdleTorrentRuntime();
  return true;
}
