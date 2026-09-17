import { randomUUID } from "node:crypto";

const RESULT_TTL_MS = 10 * 60 * 1000;
const storeKey = Symbol.for("torplay.searchResults");

function getStore() {
  if (!globalThis[storeKey]) {
    globalThis[storeKey] = new Map();
  }

  return globalThis[storeKey];
}

function removeExpired(store, now = Date.now()) {
  for (const [id, result] of store) {
    if (result.expiresAt <= now) {
      store.delete(id);
    }
  }
}

export function saveSearchResult(source) {
  const store = getStore();
  removeExpired(store);

  const id = randomUUID();
  store.set(id, {
    source,
    expiresAt: Date.now() + RESULT_TTL_MS,
  });

  return id;
}

export function getSearchResult(id) {
  if (typeof id !== "string") {
    return null;
  }

  const store = getStore();
  removeExpired(store);
  return store.get(id)?.source ?? null;
}

export function updateSearchResult(id, updates) {
  const store = getStore();
  removeExpired(store);
  const result = store.get(id);
  if (!result || !updates || typeof updates !== "object") return false;
  result.source = { ...result.source, ...updates };
  return true;
}
