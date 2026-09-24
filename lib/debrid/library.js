import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { getDatabase } from "../database/sqlite.js";
import { classifyVideoFile } from "../torrent/manager.js";
import { getMovieDetails, getSeasonDetails, getShowDetails } from "../metadata/tmdb.js";
import { findLargestFile, isExtraMediaFile, matchesEpisode, safeTorrentRelativePath } from "../video/episode.js";
import { autoMapEpisodeFiles, episodeMappingsForFiles, resolveEpisodeFile, saveEpisodeFileMapping } from "../video/episode-mapping.js";
import { readDebridConfig } from "./config.js";
import { DebridError } from "./http.js";
import { makeDebridProvider } from "./session.js";

const ids = new Set(["real-debrid", "torbox"]);
const locks = new Map();
const selectionPolls = new Map();
const stamp = () => Date.now();
const accountKey = (id) => createHash("sha256").update(String(id)).digest("hex");

function mediaLink(db, id, accountHash, resourceId) {
  return db.prepare(`SELECT * FROM debrid_media_links WHERE provider = ? AND account_hash = ?
    AND resource_id = ?`).get(id, accountHash, String(resourceId));
}

function saveMediaLink(db, id, accountHash, resourceId, infoHash, context, source, releaseName = "") {
  if (!/^[a-f0-9]{40}$/.test(String(infoHash || "").toLowerCase())
    || !["movie", "show"].includes(context?.type)
    || !Number.isSafeInteger(Number(context.tmdbId)) || Number(context.tmdbId) < 1) return;
  if (source === "torplay" && context.type === "movie"
    && (!Number.isSafeInteger(Number(context.year))
      || !String(releaseName).match(/(?:^|\D)((?:19|20)\d{2})(?!\d)/g)
        ?.some((match) => Number(match.match(/(?:19|20)\d{2}/)?.[0]) === Number(context.year)))) return;
  db.prepare(`INSERT INTO debrid_media_links
    (provider, account_hash, resource_id, info_hash, media_type, tmdb_id,
     media_context_json, source, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider, account_hash, resource_id) DO UPDATE SET
      info_hash = excluded.info_hash, media_type = excluded.media_type,
      tmdb_id = excluded.tmdb_id, media_context_json = excluded.media_context_json,
      source = excluded.source, updated_at = excluded.updated_at
    WHERE debrid_media_links.source != 'manual' OR excluded.source = 'manual'`)
    .run(id, accountHash, String(resourceId), String(infoHash).toLowerCase(), context.type,
      Number(context.tmdbId), JSON.stringify(context), source, stamp());
}

async function mapLimited(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await mapper(items[index]);
    }
  }));
  return results;
}

function invalid(message, status = 400) {
  throw new DebridError("invalid-resource", message, status);
}

export async function connectedProvider(id, dependencies = {}) {
  if (dependencies.connectedProvider) return dependencies.connectedProvider;
  if (!ids.has(id)) invalid("Unknown debrid provider.");
  const config = dependencies.config || await readDebridConfig();
  const credential = config.credentials[id];
  if (!credential) throw new DebridError("not-configured", "Connect this debrid provider first.", 422);
  const provider = (dependencies.providerFactory || makeDebridProvider)(id, credential, dependencies);
  const account = await provider.getAccountInfo();
  return { provider, accountHash: accountKey(`${id}:${account.id}`), config };
}

function filesOf(id, raw) {
  const files = id === "real-debrid" ? raw.files : raw.files || [];
  return files.map((file) => {
    const filePath = id === "real-debrid" ? String(file.path || "")
      : String(file.name || file.short_name || "");
    const name = path.posix.basename(filePath);
    return {
      providerId: String(file.id), name,
      path: safeTorrentRelativePath(filePath.replace(/^\/+/, ""), name),
      size: Number(id === "real-debrid" ? file.bytes : file.size),
      selected: id === "real-debrid" ? file.selected === 1 : true,
    };
  }).filter((file) => file.providerId && file.name && Number.isSafeInteger(file.size) && file.size > 0);
}

function normalize(id, raw, row = null, db = getDatabase()) {
  const ready = id === "real-debrid"
    ? raw.status === "downloaded" && Array.isArray(raw.links) && raw.links.length > 0
    : raw.download_present === true && raw.download_finished === true;
  const failed = id === "real-debrid"
    ? ["magnet_error", "error", "virus", "dead"].includes(raw.status)
    : /error|failed/i.test(String(raw.download_state || ""));
  const processing = id === "real-debrid"
    ? ["magnet_conversion", "waiting_files_selection", "compressing", "uploading"].includes(raw.status)
    : /meta|checking|upload/i.test(String(raw.download_state || ""));
  const progressValue = raw.progress == null ? NaN : Number(raw.progress);
  const progress = Number.isFinite(progressValue) && progressValue >= 0
    ? Math.max(0, Math.min(1, id === "real-debrid" ? progressValue / 100 : progressValue)) : null;
  const files = Array.isArray(raw.files) ? filesOf(id, raw) : [];
  const context = row?.media_context_json ? JSON.parse(row.media_context_json) : null;
  const infoHash = String(raw.hash || row?.info_hash || "").toLowerCase();
  const videoFiles = files.filter((file) => classifyVideoFile(file.name));
  const episodeMatch = context?.type === "show" ? chosen(videoFiles, context, infoHash, db) : null;
  return {
    provider: id, resourceId: String(raw.id),
    infoHash,
    name: String(raw.filename || raw.name || row?.title || "Untitled torrent"),
    size: Number(raw.bytes || raw.size) || null,
    status: id === "real-debrid" && raw.status === "waiting_files_selection"
      && row?.selection_scope === "all" && videoFiles.length > 1 && !row.selection_file_ids_json
      ? "awaiting-selection" : ready ? "ready" : failed ? "failed" : processing ? "processing"
      : /queue|pause|stall/i.test(String(raw.status || raw.download_state || "")) ? "queued" : "downloading",
    progress, files: videoFiles
      .sort((a, b) => Number(/sample/i.test(a.name)) - Number(/sample/i.test(b.name))),
    episodeMappings: episodeMappingsForFiles(infoHash, context, videoFiles, db),
    suggestedSelectionIds: videoFiles.filter((file) => !isExtraMediaFile(file)).map((file) => file.providerId),
    createdAt: raw.added || raw.created_at || row?.created_at || null,
    ownership: row?.ownership || "external",
    mediaContext: context,
    selectedFileId: context?.type === "show"
      ? (episodeMatch?.selected ? episodeMatch.providerId : null) : row?.selected_file_id || null,
    selectionScope: row?.selection_scope || null,
  };
}

function rowFor(db, id, accountHash, resourceId, scope = null) {
  if (scope) {
    const scoped = db.prepare(`SELECT * FROM debrid_resources WHERE provider = ? AND account_hash = ?
      AND resource_id = ? AND selection_scope = ? LIMIT 1`).get(id, accountHash, String(resourceId), scope);
    return scoped || null;
  }
  return db.prepare(`SELECT * FROM debrid_resources WHERE provider = ? AND account_hash = ?
    AND resource_id = ? ORDER BY updated_at DESC LIMIT 1`).get(id, accountHash, String(resourceId));
}

export async function listDebridLibrary({ provider: filter = "all", page = 1, limit = 50, fresh = false } = {}, dependencies = {}) {
  if (filter !== "all" && !ids.has(filter)) invalid("Invalid provider filter.");
  if (!Number.isInteger(page) || page < 1 || page > 10_000 || !Number.isInteger(limit) || limit < 1 || limit > 100) invalid("Invalid library page.");
  const config = dependencies.config || await readDebridConfig();
  const selected = filter === "all" ? [...ids] : [filter];
  const db = dependencies.database || getDatabase();
  const results = await Promise.all(selected.map(async (id) => {
    if (!config.credentials[id]) return { provider: id, items: [], hasMore: false, disconnected: true };
    try {
      const { provider, accountHash } = await connectedProvider(id, { ...dependencies, config });
      const list = id === "real-debrid" ? await provider.listResources(page, limit)
        : await provider.listResources((page - 1) * limit, limit, fresh);
      const items = await mapLimited(list, 3, async (raw) => {
        const row = rowFor(db, id, accountHash, raw.id);
        const link = mediaLink(db, id, accountHash, raw.id);
        if (id === "real-debrid" && row && raw.status === "waiting_files_selection") {
          try { return await getDebridItem(id, raw.id, { ...dependencies, config, selectionScope: row.selection_scope }); }
          catch (error) { console.info("Debrid selection recovery failed", { provider: id, code: error.code || "unavailable" }); }
        }
        if (link?.media_type === "show" && (id === "real-debrid"
          ? raw.status === "downloaded" : raw.download_present && raw.download_finished)) {
          try { return await getDebridItem(id, raw.id, { ...dependencies, config,
            connectedProvider: { provider, accountHash, config } }); }
          catch (error) { console.info("Debrid mapping refresh failed", { provider: id, code: error.code || "unavailable" }); }
        }
        return { ...normalize(id, raw, link ? { ...row, media_context_json: link.media_context_json } : row, db),
          associationSource: link?.source || null };
      });
      return { provider: id, items, hasMore: list.length === limit };
    } catch (error) {
      console.info("Debrid library refresh failed", { provider: id, code: error.code || "unavailable" });
      return { provider: id, items: [], hasMore: false, error: error.message };
    }
  }));
  return { providers: results, items: results.flatMap((result) => result.items)
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || ""))) };
}

function chosen(files, context, infoHash = null, database = getDatabase()) {
  const candidates = files.filter((file) => classifyVideoFile(file.name) && !isExtraMediaFile(file));
  if (context?.type === "show") return resolveEpisodeFile(infoHash, context,
    candidates.map((file) => ({ ...file, relativePath: file.path })), context.season,
    context.episode, { allowSingleFileFallback: true, database });
  return findLargestFile(candidates.map((file) => ({ ...file, relativePath: file.path })));
}

function forRequestedEpisode(item, context, infoHash, db) {
  if (context?.type !== "show") return item;
  const match = chosen(item.files, context, infoHash, db);
  const selected = match?.selected ? match : null;
  return { ...item, mediaContext: context, selectedFileId: selected?.providerId || null,
    missingEpisode: item.status === "ready" && !selected };
}

export async function confirmRealDebridFiles(resourceId, fileIds, episodeFileId, dependencies = {}) {
  const { provider, accountHash } = await connectedProvider("real-debrid", dependencies);
  const db = dependencies.database || getDatabase();
  const row = rowFor(db, "real-debrid", accountHash, resourceId);
  if (!row || row.selection_scope !== "all") invalid("This season download was not found.", 404);
  const context = row.media_context_json ? JSON.parse(row.media_context_json) : null;
  if (context?.type !== "show") invalid("This download is not a show season.");
  const raw = await provider.getResource(resourceId);
  if (raw.status !== "waiting_files_selection") invalid("File selection has already started.", 409);
  if (row.selection_file_ids_json) invalid("File selection was already confirmed.", 409);
  const files = filesOf("real-debrid", raw).filter((file) => classifyVideoFile(file.name)
    && !isExtraMediaFile(file));
  const ids = Array.isArray(fileIds) ? [...new Set(fileIds.map(String))] : [];
  if (!ids.length || ids.some((id) => !files.some((file) => file.providerId === id))) {
    invalid("Choose the video files to download.");
  }
  const episodeFile = files.find((file) => file.providerId === String(episodeFileId));
  if (!episodeFile || !ids.includes(episodeFile.providerId)) {
    invalid("Identify the requested episode among the selected video files.");
  }
  saveEpisodeFileMapping(row.info_hash, context, episodeFile, db);
  db.prepare(`UPDATE debrid_resources SET selection_file_ids_json = ?, updated_at = ?
    WHERE provider = 'real-debrid' AND account_hash = ? AND resource_id = ? AND selection_scope = 'all'`)
    .run(JSON.stringify(ids), stamp(), accountHash, String(resourceId));
  return getDebridItem("real-debrid", resourceId, { ...dependencies, selectionScope: "all" });
}

export async function mapDebridEpisodeFile(id, resourceId, fileId, season, episode, dependencies = {}) {
  const { accountHash } = await connectedProvider(id, dependencies);
  const db = dependencies.database || getDatabase();
  const row = rowFor(db, id, accountHash, resourceId);
  const link = mediaLink(db, id, accountHash, resourceId);
  if (!row && !link) invalid("This resource has no show context in TorPlay.", 404);
  const contextJson = link?.media_context_json || row?.media_context_json;
  const context = contextJson ? JSON.parse(contextJson) : null;
  const item = await getDebridItem(id, resourceId, dependencies);
  const file = item?.files.find((entry) => entry.providerId === String(fileId));
  if (!file || context?.type !== "show") invalid("Choose a video file from this show resource.", 422);
  if (link && item.infoHash !== link.info_hash) {
    invalid("This provider resource changed. Associate it with the show again.", 409);
  }
  const episodeContext = { ...context, season: Number(season), episode: Number(episode) };
  try { saveEpisodeFileMapping(link?.info_hash || row.info_hash, episodeContext, file, db); }
  catch (error) { invalid(error.message); }
  return getDebridItem(id, resourceId, dependencies);
}

async function selectRealDebrid(provider, raw, row, db) {
  if (raw.status !== "waiting_files_selection" || row.selected_file_id) return;
  const files = filesOf("real-debrid", raw);
  const context = row.media_context_json ? JSON.parse(row.media_context_json) : null;
  const selected = chosen(files, context, row.info_hash, db);
  const selectable = files.filter((file) => classifyVideoFile(file.name) && !isExtraMediaFile(file));
  const needsConfirmation = row.selection_scope === "all" && context?.type === "show"
    && selectable.length > 1;
  if (needsConfirmation && !row.selection_file_ids_json) return;
  const confirmed = needsConfirmation ? JSON.parse(row.selection_file_ids_json) : null;
  const selectionIds = confirmed || (selected ? [selected.providerId] : []);
  if (!selectionIds.length) return;
  if (selectionIds.some((id) => !selectable.some((file) => file.providerId === id))) {
    invalid("A selected video file is no longer in this provider resource.", 409);
  }
  await provider.selectFiles(raw.id, selectionIds);
  db.prepare(`UPDATE debrid_resources SET selected_file_id = ?, updated_at = ?
    WHERE provider = 'real-debrid' AND account_hash = ? AND resource_id = ? AND selection_scope = ?`)
    .run(selected?.providerId || null, stamp(), row.account_hash, String(raw.id), row.selection_scope);
}

export async function getDebridItem(id, resourceId, dependencies = {}) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(String(resourceId))) invalid("Invalid resource ID.");
  if (dependencies.selectionScope && !/^(all|movie|episode:\d{1,3}:\d{1,4})$/.test(dependencies.selectionScope)) {
    invalid("Invalid download selection.");
  }
  const { provider, accountHash } = await connectedProvider(id, dependencies);
  const db = dependencies.database || getDatabase();
  const row = rowFor(db, id, accountHash, resourceId, dependencies.selectionScope);
  if (dependencies.selectionScope && !row) invalid("This download selection was not found.", 404);
  let raw;
  try { raw = dependencies.raw || await provider.getResource(resourceId); }
  catch (error) { if (error.upstreamStatus === 404) return null; throw error; }
  if (id === "real-debrid" && row) {
    await selectRealDebrid(provider, raw, row, db);
    if (raw.status === "waiting_files_selection") raw = await provider.getResource(resourceId);
  }
  const rowContext = row?.media_context_json ? JSON.parse(row.media_context_json) : null;
  if (rowContext && !mediaLink(db, id, accountHash, resourceId)) {
    saveMediaLink(db, id, accountHash, resourceId, raw.hash || row.info_hash, rowContext,
      "torplay", row.title);
  }
  const link = mediaLink(db, id, accountHash, resourceId);
  const effectiveRow = link ? { ...row, media_context_json: link.media_context_json } : row;
  const context = effectiveRow?.media_context_json ? JSON.parse(effectiveRow.media_context_json) : null;
  const infoHash = String(raw.hash || link?.info_hash || row?.info_hash || "").toLowerCase();
  if (context?.type === "show" && Array.isArray(raw.files)) {
    const files = filesOf(id, raw).filter((file) => classifyVideoFile(file.name));
    autoMapEpisodeFiles(infoHash, context, files, [], db);
    const mapped = new Set(episodeMappingsForFiles(infoHash, context, files, db)
      .map((entry) => entry.fileId));
    const ready = id === "real-debrid" ? raw.status === "downloaded"
      : raw.download_present === true && raw.download_finished === true;
    if (!dependencies.skipEpisodeMetadata && ready && files.length > 1 && mapped.size < files.length
      && Number.isInteger(Number(context.season))) {
      try {
        const season = await (dependencies.getSeasonDetails || getSeasonDetails)(
          context.tmdbId, context.season);
        autoMapEpisodeFiles(infoHash, context, files, season.episodes, db);
      } catch (error) {
        console.info("Debrid episode metadata unavailable", { provider: id, code: error.code || "unavailable" });
      }
    }
  }
  const item = normalize(id, raw, effectiveRow, db);
  item.associationSource = link?.source || null;
  console.info("Debrid resource status", { provider: id, resourceId: String(resourceId),
    status: item.status, progress: item.progress, ownership: item.ownership });
  if (row && !row.selected_file_id && item.files.length) {
    const context = row.media_context_json ? JSON.parse(row.media_context_json) : null;
    const match = chosen(item.files, context, row.info_hash, db);
    const selected = match?.selected ? match : null;
    if (selected) {
      db.prepare(`UPDATE debrid_resources SET selected_file_id = ?, updated_at = ?
        WHERE provider = ? AND account_hash = ? AND resource_id = ? AND selection_scope = ?`)
        .run(selected.providerId, stamp(), id, accountHash, String(resourceId), row.selection_scope);
      item.selectedFileId = selected.providerId;
    }
  }
  return item;
}

function trackRealDebridSelection(item, dependencies = {}) {
  if (item.provider !== "real-debrid" || item.selectedFileId
    || ["ready", "failed", "cancelled"].includes(item.status)) return;
  const key = `${item.provider}:${item.resourceId}:${item.selectionScope}`;
  if (selectionPolls.has(key)) return;
  const started = stamp();
  const tick = async () => {
    try {
      const latest = await getDebridItem(item.provider, item.resourceId,
        { ...dependencies, selectionScope: item.selectionScope });
      if (!latest || latest.selectedFileId || ["ready", "failed"].includes(latest.status)) {
        selectionPolls.delete(key);
        return;
      }
    } catch (error) {
      if (error.code === "not-configured") { selectionPolls.delete(key); return; }
      console.info("Debrid selection poll failed", { provider: item.provider, code: error.code || "unavailable" });
    }
    if (stamp() - started > 2 * 60 * 60 * 1000) { selectionPolls.delete(key); return; }
    const timer = setTimeout(tick, 15_000);
    timer.unref?.();
    selectionPolls.set(key, timer);
  };
  const timer = setTimeout(tick, 15_000);
  timer.unref?.();
  selectionPolls.set(key, timer);
}

export async function rememberReadyResource(id, provider, infoHash, resourceId, source, dependencies = {}) {
  const account = await provider.getAccountInfo();
  const accountHash = accountKey(`${id}:${account.id}`);
  const db = dependencies.database || getDatabase();
  const now = stamp();
  db.prepare(`INSERT OR IGNORE INTO debrid_resources
    (provider, account_hash, info_hash, resource_id, title, media_context_json, selection_scope, ownership, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, accountHash, infoHash,
    String(resourceId), String(source.releaseName || "Torrent").slice(0, 300),
    source.mediaContext ? JSON.stringify(source.mediaContext) : null,
    source.mediaContext?.type === "show" ? "all" : "movie",
    dependencies.resourceOwned ? "torplay" : "external", now, now);
  saveMediaLink(db, id, accountHash, resourceId, infoHash, source.mediaContext,
    "torplay", source.releaseName);
}

async function findByHash(provider, id, infoHash, renew = () => {}) {
  const limit = id === "real-debrid" ? 500 : 1000;
  for (let page = 1; page <= 100; page += 1) {
    renew();
    const list = id === "real-debrid" ? await provider.listResources(page, limit)
      : await provider.listResources((page - 1) * limit, limit, true);
    const match = list.find((item) => String(item.hash || "").toLowerCase() === infoHash);
    if (match) return match;
    if (list.length < limit) return null;
  }
  throw new DebridError("account-scan-incomplete", "Could not finish checking this provider account for an existing torrent.", 503);
}

export async function createDebridJob(id, descriptor, { scope = "episode" } = {}, dependencies = {}) {
  if (!/^[a-f0-9]{40}$/.test(descriptor?.infoHash || "")) invalid("Invalid torrent hash.");
  if (!["episode", "all"].includes(scope)) invalid("Invalid selection scope.");
  const { provider, accountHash } = await connectedProvider(id, dependencies);
  const db = dependencies.database || getDatabase();
  const context = descriptor.mediaContext || null;
  const scopeKey = context?.type === "show" ? "all" : "movie";
  const key = `${id}:${accountHash}:${descriptor.infoHash}`;
  while (locks.has(key)) await locks.get(key);
  let release;
  locks.set(key, new Promise((resolve) => { release = resolve; }));
  const ownerToken = randomUUID();
  try {
    const lease = db.prepare(`INSERT INTO debrid_submission_locks
      (provider, account_hash, info_hash, owner_token, lease_until)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(provider, account_hash, info_hash) DO UPDATE SET
        owner_token = excluded.owner_token, lease_until = excluded.lease_until
      WHERE debrid_submission_locks.lease_until < ?`)
      .run(id, accountHash, descriptor.infoHash, ownerToken, stamp() + 90_000, stamp());
    if (lease.changes !== 1) {
      throw new DebridError("submitting", "This provider torrent is already being checked or submitted. Try again shortly.", 409);
    }
    const existing = db.prepare(`SELECT * FROM debrid_resources WHERE provider = ?
      AND account_hash = ? AND info_hash = ? AND selection_scope = ?`)
      .get(id, accountHash, descriptor.infoHash, scopeKey);
    if (existing?.resource_id) {
      db.prepare(`UPDATE debrid_resources SET media_context_json = ?, updated_at = ?
        WHERE provider = ? AND account_hash = ? AND info_hash = ? AND selection_scope = ?`)
        .run(context ? JSON.stringify(context) : null, stamp(), id, accountHash, descriptor.infoHash, scopeKey);
      const item = await getDebridItem(id, existing.resource_id, { ...dependencies, selectionScope: scopeKey });
      if (item) return forRequestedEpisode(item, context, descriptor.infoHash, db);
    }
    if (existing && !existing.resource_id && stamp() - existing.updated_at < 60_000) {
      throw new DebridError("submitting", "This provider submission is already in progress. Check Debrid Library shortly.", 409);
    }
    const renew = () => db.prepare(`UPDATE debrid_submission_locks SET lease_until = ?
      WHERE provider = ? AND account_hash = ? AND info_hash = ? AND owner_token = ?`)
      .run(stamp() + 90_000, id, accountHash, descriptor.infoHash, ownerToken);
    const found = await findByHash(provider, id, descriptor.infoHash, renew);
    if (found) {
      const prior = rowFor(db, id, accountHash, found.id);
      const now = stamp();
      db.prepare(`INSERT INTO debrid_resources
        (provider, account_hash, info_hash, resource_id, title, media_context_json, selection_scope, ownership, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(provider, account_hash, info_hash, selection_scope) DO UPDATE SET
          resource_id = excluded.resource_id, media_context_json = excluded.media_context_json,
          updated_at = excluded.updated_at`)
        .run(id, accountHash, descriptor.infoHash, String(found.id), String(descriptor.title || "Torrent").slice(0, 300),
          context ? JSON.stringify(context) : null, scopeKey, prior?.ownership || "external", now, now);
      const reused = await getDebridItem(id, found.id, { ...dependencies, selectionScope: scopeKey });
      if (!reused) throw new DebridError("unavailable", "The matching provider resource disappeared. Try again shortly.", 503);
      trackRealDebridSelection(reused, dependencies);
      return forRequestedEpisode(reused, context, descriptor.infoHash, db);
    }
    const now = stamp();
    db.prepare(`INSERT INTO debrid_resources
      (provider, account_hash, info_hash, resource_id, title, media_context_json, selection_scope, ownership, created_at, updated_at)
      VALUES (?, ?, ?, NULL, ?, ?, ?, 'torplay', ?, ?)
      ON CONFLICT(provider, account_hash, info_hash, selection_scope) DO UPDATE SET updated_at = excluded.updated_at`)
      .run(id, accountHash, descriptor.infoHash, String(descriptor.title || "Torrent").slice(0, 300),
        context ? JSON.stringify(context) : null, scopeKey, now, now);
    renew();
    const resourceId = await provider.submit(descriptor.magnet);
    db.prepare(`UPDATE debrid_resources SET resource_id = ?, updated_at = ? WHERE provider = ?
      AND account_hash = ? AND info_hash = ? AND selection_scope = ?`)
      .run(String(resourceId), stamp(), id, accountHash, descriptor.infoHash, scopeKey);
    console.info("Debrid resource submitted", { provider: id, resourceId: String(resourceId), ownership: "torplay" });
    const created = await getDebridItem(id, resourceId, { ...dependencies, selectionScope: scopeKey });
    trackRealDebridSelection(created, dependencies);
    return forRequestedEpisode(created, context, descriptor.infoHash, db);
  } finally {
    db.prepare(`DELETE FROM debrid_submission_locks WHERE provider = ? AND account_hash = ?
      AND info_hash = ? AND owner_token = ?`).run(id, accountHash, descriptor.infoHash, ownerToken);
    locks.delete(key);
    release();
  }
}

export async function deleteDebridItem(id, resourceId, dependencies = {}) {
  const { provider, accountHash } = await connectedProvider(id, dependencies);
  const item = await getDebridItem(id, resourceId, dependencies);
  if (!item) return false;
  const { stopDebridResourceSessions } = await import("./session.js");
  await stopDebridResourceSessions(id, String(resourceId));
  await provider.deleteResource(resourceId);
  for (const [key, timer] of selectionPolls) {
    if (key.startsWith(`${id}:${resourceId}:`)) {
      clearTimeout(timer);
      selectionPolls.delete(key);
    }
  }
  (dependencies.database || getDatabase()).prepare(`DELETE FROM debrid_resources WHERE provider = ?
    AND account_hash = ? AND resource_id = ?`).run(id, accountHash, String(resourceId));
  (dependencies.database || getDatabase()).prepare(`DELETE FROM debrid_media_links WHERE provider = ?
    AND account_hash = ? AND resource_id = ?`).run(id, accountHash, String(resourceId));
  return true;
}

export async function playDebridItem(id, resourceId, fileId, dependencies = {}) {
  const connected = await connectedProvider(id, dependencies);
  const raw = dependencies.raw || await connected.provider.getResource(resourceId);
  const item = dependencies.item || await getDebridItem(id, resourceId,
    { ...dependencies, connectedProvider: connected, raw });
  if (!item) invalid("Debrid resource not found.", 404);
  if (item.status !== "ready") invalid("This provider resource is still preparing.", 409);
  const file = item.files.find((entry) => entry.providerId === String(fileId) && entry.selected);
  if (!file) invalid("Choose a ready video file from this resource.", 422);
  const { provider } = connected;
  const availability = { status: "available", files: filesOf(id, raw).filter((entry) => entry.selected),
    resource: { id: resourceId, owned: item.ownership === "torplay", links: raw.links || [] } };
  const { startDebridResourcePlayback } = await import("./session.js");
  let mediaContext = dependencies.requestedMediaContext || item.mediaContext;
  if (!dependencies.requestedMediaContext && mediaContext?.type === "show") {
    const mapped = item.episodeMappings.find((entry) => entry.fileId === file.providerId);
    const match = /S(\d{1,2})E(\d{1,3})/i.exec(file.path || file.name);
    mediaContext = mapped ? { ...mediaContext, season: mapped.season, episode: mapped.episode }
      : match && matchesEpisode(file.path || file.name, Number(match[1]), Number(match[2]))
        ? { ...mediaContext, season: Number(match[1]), episode: Number(match[2]) } : null;
  } else if (!dependencies.requestedMediaContext && mediaContext?.type === "movie"
    && item.associationSource !== "manual" && item.selectedFileId !== file.providerId) {
    mediaContext = null;
  }
  return startDebridResourcePlayback({ providerId: id, provider, resourceId, infoHash: item.infoHash, availability,
    selection: file, mediaContext, releaseName: item.name }, dependencies);
}

export async function associateDebridItem(id, resourceId, input, dependencies = {}) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(String(resourceId))) invalid("Invalid resource ID.");
  const type = input?.type;
  const tmdbId = Number(input?.tmdbId);
  const season = type === "show" ? Number(input?.season) : null;
  if (!["movie", "show"].includes(type) || !Number.isSafeInteger(tmdbId) || tmdbId < 1
    || (type === "show" && (!Number.isSafeInteger(season) || season < 0))) {
    invalid("Choose a valid TMDB title and show season.");
  }
  const connected = await connectedProvider(id, dependencies);
  const db = dependencies.database || getDatabase();
  const raw = await connected.provider.getResource(resourceId);
  if (!/^[a-f0-9]{40}$/.test(String(raw.hash || "").toLowerCase())) {
    invalid("This provider resource has no usable torrent identity.", 422);
  }
  const row = rowFor(db, id, connected.accountHash, resourceId);
  if (row?.ownership === "torplay") invalid("TorPlay resources already have a title association.", 409);
  const details = type === "show"
    ? await (dependencies.getShowDetails || getShowDetails)(tmdbId)
    : await (dependencies.getMovieDetails || getMovieDetails)(tmdbId);
  if (type === "show" && !details.seasons.some((entry) => entry.number === season)) {
    invalid("Choose a season that belongs to this show.");
  }
  const context = { type, tmdbId, title: details.title, imdbId: details.imdbId || null,
    year: details.year ? Number(details.year) : null,
    ...(type === "show" ? { season } : {}) };
  saveMediaLink(db, id, connected.accountHash, resourceId, raw.hash, context, "manual");
  return getDebridItem(id, resourceId, { ...dependencies, connectedProvider: connected, raw });
}

export async function dissociateDebridItem(id, resourceId, dependencies = {}) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(String(resourceId))) invalid("Invalid resource ID.");
  const connected = await connectedProvider(id, dependencies);
  const db = dependencies.database || getDatabase();
  db.prepare(`DELETE FROM debrid_media_links WHERE provider = ? AND account_hash = ?
    AND resource_id = ? AND source = 'manual'`).run(id, connected.accountHash, String(resourceId));
  return getDebridItem(id, resourceId, { ...dependencies, connectedProvider: connected });
}

export async function resolveDirectDebridPlayback(context, dependencies = {}) {
  const tmdbId = Number(context?.tmdbId);
  if (!["movie", "show"].includes(context?.type) || !Number.isSafeInteger(tmdbId) || tmdbId < 1
    || (context.type === "show" && (!Number.isSafeInteger(Number(context.season))
      || Number(context.season) < 0 || !Number.isSafeInteger(Number(context.episode))
      || Number(context.episode) < 1))) invalid("Invalid media identity.");
  const config = dependencies.config || await readDebridConfig();
  if (config.mode === "local") return { kind: "miss" };
  const db = dependencies.database || getDatabase();
  for (const id of config.priority) {
    if (!config.credentials[id]) continue;
    const links = db.prepare(`SELECT * FROM debrid_media_links WHERE media_type = ? AND tmdb_id = ?
      AND provider = ? ORDER BY updated_at DESC LIMIT 50`).all(context.type, tmdbId, id);
    if (!links.length) continue;
    let connected;
    try { connected = await connectedProvider(id, dependencies); }
    catch (error) {
      console.info("Direct debrid account unavailable", { provider: id, code: error.code || "unavailable" });
      continue;
    }
    for (const link of links.filter((entry) => entry.account_hash === connected.accountHash)) {
      try {
        const raw = await connected.provider.getResource(link.resource_id);
        if (String(raw.hash || "").toLowerCase() !== link.info_hash) continue;
        const item = await getDebridItem(id, link.resource_id,
          { ...dependencies, connectedProvider: connected, raw, skipEpisodeMetadata: true });
        if (item?.status !== "ready") continue;
        const selected = item.files.filter((file) => file.selected);
        const file = context.type === "show"
          ? resolveEpisodeFile(item.infoHash, context, selected.map((entry) => ({
            ...entry, relativePath: entry.path,
          })), context.season, context.episode, { database: db, allowSingleFileFallback: false })
          : findLargestFile(selected);
        if (!file) continue;
        const requestedMediaContext = { ...JSON.parse(link.media_context_json),
          ...(context.type === "show" ? { season: Number(context.season), episode: Number(context.episode) } : {}) };
        const fileId = filesOf(id, raw).filter((entry) => entry.selected)
          .findIndex((entry) => entry.providerId === file.providerId);
        if (fileId < 0) continue;
        const session = await playDebridItem(id, link.resource_id, file.providerId,
          { ...dependencies, connectedProvider: connected, raw, item, requestedMediaContext });
        return { kind: "hit", session, fileId: String(fileId) };
      } catch (error) {
        if (error.upstreamStatus === 404) {
          db.prepare(`DELETE FROM debrid_media_links WHERE provider = ? AND account_hash = ?
            AND resource_id = ?`).run(id, connected.accountHash, link.resource_id);
        }
        console.info("Direct debrid resource unavailable", { provider: id, code: error.code || "unavailable" });
      }
    }
  }
  return { kind: "miss" };
}
