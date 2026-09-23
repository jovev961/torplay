import { createHash, randomUUID } from "node:crypto";
import http from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  beginStream, classifyVideoFile, findSessionEpisode, getTorrentMediaContext,
  getTorrentSession, getVideoFile, getSubtitleFile, resolveTorrentInput, startTorrent,
  stopActiveConversionForFile, stopTorrent, updateTorrentMediaContext,
} from "../torrent/manager.js";
import { classifySubtitleFile } from "../video/subtitles.js";
import { findEpisodeFile, findLargestFile, safeTorrentRelativePath } from "../video/episode.js";
import { readDebridConfig, updateDebridConfig } from "./config.js";
import { DebridError } from "./http.js";
import { RealDebridProvider } from "./real-debrid.js";
import { TorBoxProvider } from "./torbox.js";
import { probeRemoteUrl, proxyRemoteFile } from "./stream.js";
import { createDebridJob, rememberCreatedResource } from "./library.js";

const key = Symbol.for("torplay.debridSessions");
function state() {
  globalThis[key] ??= {
    sessions: new Map(), resources: new Map(), localResolution: new Map(),
    availabilityCache: new Map(), inflight: new Map(), cooldown: new Map(),
    server: null, port: null, bridgeKey: randomUUID(), cleanupTimer: null,
  };
  return globalThis[key];
}

function ensureCleanup() {
  const current = state();
  if (current.cleanupTimer) return;
  current.cleanupTimer = setInterval(() => {
    const cutoff = Date.now() - 2 * 60 * 1000;
    for (const session of current.sessions.values()) {
      if (!session.streams && session.lastActivity < cutoff) {
        void stopPlayback(session.id);
      }
    }
  }, 60_000);
  current.cleanupTimer.unref?.();
}

export function makeDebridProvider(id, credentials, dependencies = {}) {
  if (id === "real-debrid") {
    let previous = credentials;
    return new RealDebridProvider(credentials, {
      ...dependencies,
      onRefresh: async (next) => updateDebridConfig((config) => {
        const stored = config.credentials["real-debrid"];
        if (!stored || stored.apiKey || stored.clientId !== previous.clientId
          || stored.refreshToken !== previous.refreshToken) return config;
        previous = next;
        return { ...config, credentials: { ...config.credentials, "real-debrid": next } };
      }, dependencies.configOptions),
    });
  }
  if (id === "torbox") return new TorBoxProvider(credentials, dependencies);
  return null;
}

function remoteFile(session, descriptor, index) {
  const name = String(descriptor.name || "");
  const relativePath = safeTorrentRelativePath(descriptor.path, name);
  return {
    index, providerId: descriptor.providerId, name,
    path: relativePath, length: Number(descriptor.size),
    downloaded: Number(descriptor.size),
    mimeType: classifyVideoFile(name)?.mimeType || "text/plain; charset=utf-8",
    async arrayBuffer() {
      if (this.length > 4 * 1024 * 1024) throw new Error("Subtitle file is too large.");
      const response = await proxyRemoteFile(new Request("http://localhost", {
        headers: { Range: `bytes=0-${this.length - 1}` },
      }), this, (force) => resolveRemoteUrl(session, this, force));
      if (!response.ok) throw new Error("Subtitle file is unavailable.");
      return response.arrayBuffer();
    },
  };
}

function publicSession(session) {
  return {
    id: session.id, status: "ready", name: session.releaseName,
    backend: "debrid", provider: session.providerId,
    sourceType: session.sourceType || "torrent",
    resolution: session.resolution,
    peers: 0, downloadSpeed: 0, discovery: null, error: null,
    files: session.resource.torrent.files.flatMap((file, index) => {
      const video = classifyVideoFile(file.name);
      return video ? [{
        id: String(index), name: file.name, relativePath: file.path, size: file.length,
        ...video, subtitles: [], downloaded: file.length, progress: 1, buffering: false,
      }] : [];
    }),
  };
}

export async function startUsenetPlayback(job, normalized, provider, dependencies = {}) {
  const files = normalized.files;
  const selected = chosenMedia(candidateFiles(files), job.mediaContext);
  if (!selected) throw new DebridError("file-not-found", "The requested media file was not found in this Usenet job.", 422);
  const stream = await provider.resolveStream({ id: job.torboxId }, selected);
  await (dependencies.probe || probeRemoteUrl)(stream.url);
  const session = {
    id: randomUUID(), backend: "debrid", sourceType: "usenet", providerId: "torbox", provider,
    torrent: { id: job.torboxId }, availability: null, resourceRef: null,
    mediaContext: job.mediaContext, releaseName: job.title,
    resource: { status: "ready", torrent: { files: [] }, mediaProbes: new Map() },
    selectedFileId: null, activeConversion: null, subtitleDiscoveries: new Map(),
    lastActivity: Date.now(), streams: 0, activeControllers: new Set(),
    streamUrls: new Map([[selected.providerId, stream.url]]), resolution: [],
  };
  session.resource.torrent.files = files.map((file, index) => remoteFile(session, file, index));
  state().sessions.set(session.id, session);
  ensureCleanup();
  return publicSession(session);
}

function candidateFiles(descriptors) {
  return descriptors.flatMap((file) => {
    const video = classifyVideoFile(file.name);
    return video && Number.isSafeInteger(Number(file.size)) && Number(file.size) > 0
      ? [{ ...file, relativePath: safeTorrentRelativePath(file.path, file.name), ...video }]
      : [];
  });
}

function chosenMedia(files, context) {
  if (context?.type === "show") {
    return findEpisodeFile(files, Number(context.season), Number(context.episode), {
      allowSingleFileFallback: true,
    });
  }
  return findLargestFile(files);
}

function logResolution(provider, availability, duration, reason = null, httpStatus = null) {
  console.info("Debrid resolution", {
    provider, availability, durationMs: duration,
    ...(reason ? { fallbackReason: reason } : {}),
    ...(httpStatus ? { httpStatus } : {}),
  });
}

export async function startPlaybackSource(source, dependencies = {}) {
  const config = dependencies.config || await readDebridConfig();
  const action = dependencies.action || "resolve";
  const localAllowed = config.mode !== "debrid-only" && config.localFallback !== false;
  if (config.mode === "local") return (dependencies.startLocal || startTorrent)(source);
  if (action === "local") {
    if (!localAllowed) throw new DebridError("local-disabled", "Local playback is disabled by your debrid settings.", 422);
    return (dependencies.startLocal || startTorrent)(source);
  }
  const availableProviders = config.priority.filter((id) => config.credentials[id]);
  if (!availableProviders.length && config.mode === "prefer-debrid" && localAllowed) {
    return (dependencies.startLocal || startTorrent)(source);
  }
  if (!availableProviders.length) {
    throw new DebridError("not-configured", "No debrid provider is configured.", 422);
  }
  let descriptor;
  try {
    const resolved = await resolveTorrentInput(source);
    if (!/^[a-f0-9]{40}$/.test(resolved.infoHash)) throw new Error("Unsupported torrent hash.");
    descriptor = {
      infoHash: resolved.infoHash,
      magnet: `magnet:?xt=urn:btih:${resolved.infoHash}`,
      mediaContext: source.mediaContext || null,
    };
    console.info("Debrid source resolved", { infoHash: descriptor.infoHash, mode: config.mode });
  } catch (error) {
    if (!localAllowed) throw error;
    return (dependencies.startLocal || startTorrent)(source);
  }
  const resolution = [];
  for (const id of availableProviders) {
    const started = Date.now();
    const provider = (dependencies.providerFactory || makeDebridProvider)(
      id, config.credentials[id], dependencies,
    );
    let resource = null;
    try {
      if (Date.now() < (state().cooldown.get(id) || 0)) {
        resolution.push({ provider: id, status: "rate-limited" });
        continue;
      }
      const identity = createHash("sha256").update(JSON.stringify(config.credentials[id])).digest("hex");
      const cacheKey = `${id}:${descriptor.infoHash}:${identity}`;
      let cached = state().availabilityCache.get(cacheKey);
      if (!cached || cached.expiresAt <= Date.now()) {
        let pending = state().inflight.get(cacheKey);
        if (!pending) {
          pending = provider.checkAvailability(descriptor);
          state().inflight.set(cacheKey, pending);
        }
        try {
          cached = { value: await pending, expiresAt: Date.now() + 20_000 };
          state().availabilityCache.set(cacheKey, cached);
        } finally {
          if (state().inflight.get(cacheKey) === pending) state().inflight.delete(cacheKey);
        }
      }
      const availability = cached.value;
      if (availability.status !== "available") {
        resolution.push({ provider: id, status: "not-cached" });
        logResolution(id, "miss", Date.now() - started);
        continue;
      }
      const selected = chosenMedia(candidateFiles(availability.files), source.mediaContext);
      if (!selected) {
        resolution.push({ provider: id, status: "file-not-found" });
        logResolution(id, "available", Date.now() - started, "file-not-found");
        continue;
      }
      const stream = await provider.resolveStream(descriptor, selected, availability);
      resource = stream.resource;
      await (dependencies.probe || probeRemoteUrl)(stream.url);
      if (resource?.owned && resource.id) {
        await rememberCreatedResource(id, provider, descriptor.infoHash, resource.id, source, dependencies)
          .catch((error) => console.info("Debrid resource reference could not be saved", {
            provider: id, code: error.code || "storage-error",
          }));
      }
      const session = {
        id: randomUUID(), backend: "debrid", providerId: id, provider,
        torrent: descriptor, availability, resourceRef: resource,
        mediaContext: source.mediaContext || null, releaseName: source.releaseName || selected.name,
        resource: { status: "ready", torrent: { files: [] }, mediaProbes: new Map() },
        selectedFileId: null, activeConversion: null, subtitleDiscoveries: new Map(),
        lastActivity: Date.now(), streams: 0,
        activeControllers: new Set(),
        streamUrls: new Map([[selected.providerId, stream.url]]),
        resolution: [...resolution, { provider: id, status: "available" }],
      };
      session.resource.torrent.files = availability.files.map((file, index) => remoteFile(session, file, index));
      state().sessions.set(session.id, session);
      ensureCleanup();
      if (resource?.id) {
        const resourceKey = `${id}:${resource.id}`;
        const registered = state().resources.get(resourceKey) || { ...resource, refs: 0, provider };
        registered.refs += 1;
        registered.owned ||= resource.owned;
        state().resources.set(resourceKey, registered);
      }
      logResolution(id, "available", Date.now() - started);
      return publicSession(session);
    } catch (error) {
      if (error.code === "rate-limited") {
        const delay = Number(error.retryAfter);
        state().cooldown.set(id, Date.now() + (Number.isFinite(delay) && delay > 0 ? Math.min(delay, 300) : 30) * 1000);
      }
      resolution.push({ provider: id, status: error.code || "error" });
      logResolution(id, "error", Date.now() - started, error.code || "error", error.upstreamStatus);
    }
  }
  const selectableProviders = availableProviders.filter((id) => !resolution.some((step) =>
    step.provider === id && ["authentication", "rate-limited", "not-configured"].includes(step.status)));
  if (action === "remote" || config.unavailableAction === "remote") {
    const providerId = dependencies.remoteProvider || selectableProviders[0];
    if (!selectableProviders.includes(providerId)) {
      return { kind: "choice", localAllowed, providers: selectableProviders,
        resolution, seasonPack: source.mediaContext?.type === "show",
        error: "The selected debrid provider cannot start a download right now. Test its connection in Settings." };
    }
    try {
      const item = await createDebridJob(providerId, {
        ...descriptor, title: source.releaseName || "Torrent",
      }, { scope: dependencies.scope || "episode" }, dependencies);
      return { kind: "debrid-job", item, choices: {
        localAllowed, providers: selectableProviders,
        seasonPack: source.mediaContext?.type === "show",
      } };
    } catch (error) {
      return { kind: "choice", localAllowed, providers: selectableProviders,
        resolution, seasonPack: source.mediaContext?.type === "show",
        error: `${providerId === "torbox" ? "TorBox" : "Real-Debrid"} could not start the download: ${error.message}` };
    }
  }
  if (config.unavailableAction === "ask" || !localAllowed) {
    return { kind: "choice", localAllowed, providers: selectableProviders,
      resolution, seasonPack: source.mediaContext?.type === "show" };
  }
  const local = await (dependencies.startLocal || startTorrent)(source);
  state().localResolution.set(local.id, resolution);
  return { ...local, resolution: [...resolution, { provider: "local", status: "starting" }] };
}

export async function startDebridResourcePlayback(input, dependencies = {}) {
  const { providerId, provider, resourceId, availability, selection } = input;
  const stream = await provider.resolveStream({ id: resourceId }, selection, availability);
  await (dependencies.probe || probeRemoteUrl)(stream.url);
  const session = {
    id: randomUUID(), backend: "debrid", sourceType: "torrent", providerId, provider,
    torrent: { id: resourceId }, availability, resourceRef: null,
    mediaContext: input.mediaContext || null, releaseName: input.releaseName || selection.name,
    resource: { status: "ready", torrent: { files: [] }, mediaProbes: new Map() },
    selectedFileId: null, activeConversion: null, subtitleDiscoveries: new Map(),
    lastActivity: Date.now(), streams: 0, activeControllers: new Set(),
    streamUrls: new Map([[selection.providerId, stream.url]]), resolution: [],
  };
  session.resource.torrent.files = availability.files.map((file, index) => remoteFile(session, file, index));
  state().sessions.set(session.id, session);
  ensureCleanup();
  return publicSession(session);
}

export function getDebridSession(id) {
  const session = state().sessions.get(id);
  if (session) session.lastActivity = Date.now();
  return session || null;
}

export function getPlaybackSession(id) {
  const session = getDebridSession(id);
  if (session) return publicSession(session);
  const local = getTorrentSession(id);
  return local && state().localResolution.has(id)
    ? { ...local, resolution: state().localResolution.get(id) } : local;
}

export function getPlaybackVideoFile(id, fileId) {
  const session = getDebridSession(id);
  if (!session) return getVideoFile(id, fileId);
  if (!/^\d+$/.test(String(fileId))) return null;
  const file = session.resource.torrent.files[Number(fileId)];
  const video = file && classifyVideoFile(file.name);
  return video ? { session, file, backend: "debrid", ...video } : null;
}

export function getPlaybackSubtitleFile(id, fileId) {
  const session = getDebridSession(id);
  if (!session) return getSubtitleFile(id, fileId);
  if (!/^\d+$/.test(String(fileId))) return null;
  const file = session.resource.torrent.files[Number(fileId)];
  const subtitle = file && classifySubtitleFile(file.name);
  return subtitle ? { session, file, backend: "debrid", ...subtitle } : null;
}

export async function resolveRemoteUrl(session, file, force = false) {
  const current = !force && session.streamUrls.get(file.providerId);
  if (current) return current;
  const stream = await session.provider.resolveStream(session.torrent, {
    providerId: file.providerId, name: file.name, size: file.length,
  }, session.availability);
  if (force) console.info("Debrid media URL refreshed", {
    provider: session.providerId, resourceId: String(session.torrent?.id || session.resourceRef?.id || ""),
    fileId: String(file.providerId),
  });
  session.streamUrls.set(file.providerId, stream.url);
  return stream.url;
}

export async function stopPlayback(id) {
  const session = state().sessions.get(id);
  if (!session) {
    state().localResolution.delete(id);
    return stopTorrent(id);
  }
  state().sessions.delete(id);
  for (const controller of session.activeControllers) controller.abort();
  session.activeControllers.clear();
  for (const file of session.resource.torrent.files) stopActiveConversionForFile(session, file);
  const resource = session.resourceRef;
  if (resource?.id) {
    const resourceKey = `${session.providerId}:${resource.id}`;
    const registered = state().resources.get(resourceKey);
    if (registered && --registered.refs <= 0) {
      state().resources.delete(resourceKey);
      // Provider account resources remain until an explicit Library delete.
    }
  }
  if (state().sessions.size === 0) {
    const current = state();
    if (current.cleanupTimer) clearInterval(current.cleanupTimer);
    current.cleanupTimer = null;
    if (current.server) {
      current.server.close();
      current.server = null;
      current.port = null;
    }
  }
  return true;
}

export async function stopProviderSessions(providerId) {
  for (const session of [...state().sessions.values()]) {
    if (session.providerId === providerId) await stopPlayback(session.id);
  }
  for (const key of state().availabilityCache.keys()) {
    if (key.startsWith(`${providerId}:`)) state().availabilityCache.delete(key);
  }
}

export async function stopDebridResourceSessions(providerId, resourceId) {
  for (const session of [...state().sessions.values()]) {
    if (session.providerId === providerId && String(session.torrent?.id || session.resourceRef?.id) === resourceId) {
      await stopPlayback(session.id);
    }
  }
}

export function getPlaybackMediaContext(id) {
  return getDebridSession(id)?.mediaContext || getTorrentMediaContext(id);
}

export function updatePlaybackMediaContext(id, context) {
  const session = getDebridSession(id);
  if (!session) return updateTorrentMediaContext(id, context);
  session.mediaContext = context;
  return true;
}

export function findPlaybackSessionEpisode(id, season, episode) {
  const session = getDebridSession(id);
  if (!session) return findSessionEpisode(id, season, episode);
  const file = findEpisodeFile(publicSession(session).files, season, episode, {
    allowSingleFileFallback: false,
  });
  return file ? { session: publicSession(session), file } : null;
}

export async function getRemoteInternalFileUrl(session, file) {
  const current = state();
  if (!current.server) {
    current.server = http.createServer(async (incoming, outgoing) => {
      const parts = incoming.url?.split("/");
      if (parts?.[1] !== current.bridgeKey) { outgoing.writeHead(404).end(); return; }
      const match = getPlaybackVideoFile(parts[2], parts[3])
        || getPlaybackSubtitleFile(parts[2], parts[3]);
      if (!match || match.backend !== "debrid") { outgoing.writeHead(404).end(); return; }
      const controller = new AbortController();
      match.session.activeControllers.add(controller);
      outgoing.on("close", () => controller.abort());
      const finish = beginStream(match.session);
      try {
        const request = new Request("http://localhost", {
          method: incoming.method, headers: incoming.headers, signal: controller.signal,
        });
        const response = await proxyRemoteFile(request, match.file,
          (force) => resolveRemoteUrl(match.session, match.file, force));
        outgoing.writeHead(response.status, Object.fromEntries(response.headers));
        if (response.body) await pipeline(Readable.fromWeb(response.body), outgoing);
        else outgoing.end();
      } catch { if (!outgoing.headersSent) outgoing.writeHead(502).end(); else outgoing.destroy(); }
      finally { finish(); match.session.activeControllers.delete(controller); }
    });
    await new Promise((resolve, reject) => {
      current.server.once("error", reject);
      current.server.listen(0, "127.0.0.1", resolve);
    });
    current.port = current.server.address().port;
  }
  return `http://127.0.0.1:${current.port}/${current.bridgeKey}/${session.id}/${file.index}`;
}
