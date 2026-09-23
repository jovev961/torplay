import { createHash, randomUUID } from "node:crypto";
import { getDatabase } from "../database/sqlite.js";
import { readDebridConfig } from "../debrid/config.js";
import { getDebridSession, startUsenetPlayback, stopPlayback } from "../debrid/session.js";
import { TorBoxUsenet } from "./torbox.js";
import { readUsenetConfig } from "./config.js";
import { fetchNzb, validateNzb } from "./newznab.js";

const sessionKey = Symbol.for("torplay.usenetJobSessions");
function sessions() { globalThis[sessionKey] ??= new Map(); return globalThis[sessionKey]; }
const hash = (value) => createHash("sha256").update(value).digest("hex");

async function backend(dependencies = {}) {
  const config = await (dependencies.readDebrid || readDebridConfig)();
  const apiKey = config.credentials.torbox?.apiKey;
  if (!apiKey) throw Object.assign(new Error("Connect TorBox before using Usenet."), { status: 422 });
  return { provider: dependencies.provider || new TorBoxUsenet(apiKey), accountHash: hash(apiKey) };
}

function jobRow(row) {
  return row && {
    id: row.id, torboxId: row.torbox_id, title: row.title,
    mediaContext: row.media_context_json ? JSON.parse(row.media_context_json) : null,
    createdAt: row.created_at,
  };
}

export async function createUsenetJob(input, dependencies = {}) {
  const config = await (dependencies.readUsenet || readUsenetConfig)();
  if (!config.enabled) throw Object.assign(new Error("Enable Usenet in Settings first."), { status: 403 });
  const { provider, accountHash } = await backend(dependencies);
  if (await provider.capability() === "unavailable") {
    throw Object.assign(new Error("Usenet is unavailable on this TorBox account."), { status: 422 });
  }
  let buffer;
  let title;
  if (input.buffer) {
    buffer = validateNzb(input.buffer);
    title = String(input.title || "Uploaded NZB").slice(0, 300);
  } else {
    const indexer = config.indexers.find((item) => item.id === input.indexerId);
    if (!indexer) throw Object.assign(new Error("Newznab indexer not found."), { status: 404 });
    buffer = await (dependencies.fetchNzb || fetchNzb)(indexer, input.nzbUrl);
    title = String(input.title || "Usenet source").slice(0, 300);
  }
  const nzbHash = hash(buffer);
  const db = dependencies.database || getDatabase();
  const existing = db.prepare("SELECT * FROM usenet_jobs WHERE account_hash = ? AND nzb_hash = ?")
    .get(accountHash, nzbHash);
  if (existing) return getUsenetJob(existing.id, dependencies);
  const torboxId = await provider.create(buffer);
  const id = randomUUID();
  const createdAt = Date.now();
  try {
    db.prepare(`INSERT INTO usenet_jobs
      (id, torbox_id, account_hash, nzb_hash, title, media_context_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, torboxId, accountHash, nzbHash, title,
      input.mediaContext ? JSON.stringify(input.mediaContext) : null, createdAt);
  } catch (error) {
    await provider.delete(torboxId).catch(() => {});
    throw error;
  }
  return { id, torboxId, title, mediaContext: input.mediaContext || null, createdAt,
    status: "queued", progress: null, fileCount: 0, session: null };
}

export async function getUsenetJob(id, dependencies = {}) {
  const { provider, accountHash } = await backend(dependencies);
  const db = dependencies.database || getDatabase();
  const row = db.prepare("SELECT * FROM usenet_jobs WHERE id = ? AND account_hash = ?").get(id, accountHash);
  if (!row) return null;
  const job = jobRow(row);
  let current;
  try { current = await provider.get(job.torboxId); }
  catch (error) {
    if (Date.now() - job.createdAt < 30_000 && error.code === "provider-error") {
      return { ...job, status: "queued", progress: null, fileCount: 0, session: null };
    }
    throw error;
  }
  const sessionId = sessions().get(id);
  const session = sessionId && getDebridSession(sessionId);
  return {
    ...job, status: current.status, progress: current.progress,
    message: current.message, fileCount: current.files.length,
    session: session ? { id: session.id, status: "ready", sourceType: "usenet" } : null,
  };
}

export async function listUsenetJobs(dependencies = {}) {
  const { accountHash } = await backend(dependencies);
  const db = dependencies.database || getDatabase();
  return db.prepare("SELECT * FROM usenet_jobs WHERE account_hash = ? ORDER BY created_at DESC LIMIT 100")
    .all(accountHash).map(jobRow);
}

export async function playUsenetJob(id, dependencies = {}) {
  const { provider, accountHash } = await backend(dependencies);
  const db = dependencies.database || getDatabase();
  const row = db.prepare("SELECT * FROM usenet_jobs WHERE id = ? AND account_hash = ?").get(id, accountHash);
  if (!row) return null;
  const prior = sessions().get(id);
  if (prior && getDebridSession(prior)) {
    const { getPlaybackSession } = await import("../debrid/session.js");
    return getPlaybackSession(prior);
  }
  const job = jobRow(row);
  const current = await provider.get(job.torboxId);
  if (current.status !== "ready") {
    throw Object.assign(new Error("The Usenet job is still preparing."), { status: 409 });
  }
  const session = await startUsenetPlayback(job, current, provider, dependencies);
  sessions().set(id, session.id);
  return session;
}

export async function deleteUsenetJob(id, dependencies = {}) {
  const { provider, accountHash } = await backend(dependencies);
  const db = dependencies.database || getDatabase();
  const row = db.prepare("SELECT * FROM usenet_jobs WHERE id = ? AND account_hash = ?").get(id, accountHash);
  if (!row) return false;
  const sessionId = sessions().get(id);
  if (sessionId) await stopPlayback(sessionId);
  await provider.delete(row.torbox_id);
  db.prepare("DELETE FROM usenet_jobs WHERE id = ? AND account_hash = ?").run(id, accountHash);
  sessions().delete(id);
  return true;
}
