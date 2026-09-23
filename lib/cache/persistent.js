import { getDatabase } from "../database/sqlite.js";

const MISS = Object.freeze({ hit: false, value: null });
const NAME_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/i;
const MAX_KEY_LENGTH = 2_048;

function validIdentity(namespace, key) {
  return NAME_PATTERN.test(namespace)
    && typeof key === "string"
    && key.length > 0
    && key.length <= MAX_KEY_LENGTH;
}

function databaseFrom(options) {
  return options.database || getDatabase();
}

export function readPersistentCache(namespace, key, options = {}) {
  if (!validIdentity(namespace, key)) return MISS;
  const now = options.now ?? Date.now();
  try {
    const database = databaseFrom(options);
    const row = database.prepare(`
      SELECT value_json, expires_at
      FROM external_response_cache
      WHERE namespace = ? AND cache_key = ?
    `).get(namespace, key);
    if (!row) return MISS;
    if (row.expires_at <= now) {
      database.prepare(`
        DELETE FROM external_response_cache
        WHERE namespace = ? AND cache_key = ?
      `).run(namespace, key);
      return MISS;
    }
    try {
      return { hit: true, value: JSON.parse(row.value_json) };
    } catch {
      database.prepare(`
        DELETE FROM external_response_cache
        WHERE namespace = ? AND cache_key = ?
      `).run(namespace, key);
      return MISS;
    }
  } catch {
    return MISS;
  }
}

export function writePersistentCache(namespace, key, value, options = {}) {
  if (!validIdentity(namespace, key)) return false;
  const now = options.now ?? Date.now();
  const ttlMs = Number(options.ttlMs);
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return false;
  try {
    const valueJson = JSON.stringify(value);
    if (valueJson === undefined) return false;
    const database = databaseFrom(options);
    database.prepare(`
      INSERT INTO external_response_cache (
        namespace, cache_key, value_json, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(namespace, cache_key) DO UPDATE SET
        value_json = excluded.value_json,
        expires_at = excluded.expires_at,
        created_at = excluded.created_at
    `).run(namespace, key, valueJson, now + ttlMs, now);
    database.prepare("DELETE FROM external_response_cache WHERE expires_at <= ?").run(now);
    return true;
  } catch {
    return false;
  }
}
