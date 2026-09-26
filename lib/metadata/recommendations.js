import { createHash } from "node:crypto";
import { readPersistentCache, writePersistentCache } from "../cache/persistent.js";
import { getDatabase } from "../database/sqlite.js";
import { listWatchedTitles } from "../history/service.js";
import { getTitleRecommendations } from "./tmdb.js";

const CACHE_NAMESPACE = "recommendations";
const COMPLETE_TTL_MS = 12 * 60 * 60 * 1_000;
const PARTIAL_TTL_MS = 15 * 60 * 1_000;
const REQUEST_CONCURRENCY = 4;
const inFlightByDatabase = new WeakMap();

export class RecommendationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "RecommendationError";
    this.status = status;
  }
}

function identity(item) {
  return `${item.mediaType}:${item.tmdbId ?? item.id}`;
}

function cacheKey(profileId, mode, seeds, watched, locale) {
  const signature = createHash("sha256").update(JSON.stringify({
    seeds: seeds.map(identity),
    watched: watched.map(identity).sort(),
  })).digest("hex");
  return `${profileId}:${mode}:${locale}:${signature}`;
}

async function fetchSeedPages(seeds, fetchRecommendations) {
  const pages = new Array(seeds.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < seeds.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        pages[index] = { results: await fetchRecommendations(seeds[index].mediaType, seeds[index].tmdbId) };
      } catch (error) {
        pages[index] = { error };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(REQUEST_CONCURRENCY, seeds.length) }, worker));
  return pages;
}

function rankRecommendations(pages, watched, seedCount) {
  const watchedIds = new Set(watched.map(identity));
  const ranked = new Map();
  pages.forEach((page, seedIndex) => {
    const seenInSeed = new Set();
    (Array.isArray(page.results) ? page.results : []).forEach((item, itemIndex) => {
      if (!["movie", "tv"].includes(item?.mediaType) || !Number.isInteger(item.id) || item.id < 1 || !item.title) return;
      const key = identity(item);
      if (watchedIds.has(key) || seenInSeed.has(key)) return;
      seenInSeed.add(key);
      const previous = ranked.get(key);
      if (previous) {
        previous.hits += 1;
        previous.recency += seedCount - seedIndex;
      } else {
        ranked.set(key, { item, hits: 1, recency: seedCount - seedIndex, seedIndex, itemIndex, key });
      }
    });
  });
  return [...ranked.values()].sort((left, right) =>
    right.hits - left.hits || right.recency - left.recency ||
    left.seedIndex - right.seedIndex || left.itemIndex - right.itemIndex ||
    left.key.localeCompare(right.key)).map(({ item }) => item);
}

export async function getRecommendations(profileId, {
  mode = "recent",
  locale = "en",
  database = getDatabase(),
  now = Date.now(),
  fetchRecommendations = getTitleRecommendations,
} = {}) {
  if (!["recent", "all"].includes(mode)) throw new RecommendationError("Mode must be recent or all.");
  const watched = listWatchedTitles(profileId, database);
  const seeds = watched.slice(0, mode === "all" ? 30 : 10);
  if (!seeds.length) return { mode, seedCount: 0, results: [], partial: false };

  const key = cacheKey(profileId, mode, seeds, watched, locale);
  const cached = readPersistentCache(CACHE_NAMESPACE, key, { database, now });
  if (cached.hit) return cached.value;

  let inFlight = inFlightByDatabase.get(database);
  if (!inFlight) {
    inFlight = new Map();
    inFlightByDatabase.set(database, inFlight);
  }
  if (inFlight.has(key)) return inFlight.get(key);

  const request = (async () => {
    const pages = await fetchSeedPages(seeds,
      (type, id) => fetchRecommendations(type, id, { locale }));
    const failureCount = pages.filter((page) => page.error).length;
    if (failureCount === seeds.length) {
      throw new RecommendationError("Recommendations are unavailable right now. Please try again later.", 502);
    }
    const result = {
      mode,
      seedCount: seeds.length,
      results: rankRecommendations(pages, watched, seeds.length),
      partial: failureCount > 0,
    };
    writePersistentCache(CACHE_NAMESPACE, key, result, {
      database, now, ttlMs: result.partial ? PARTIAL_TTL_MS : COMPLETE_TTL_MS,
    });
    return result;
  })();
  inFlight.set(key, request);
  try {
    return await request;
  } finally {
    inFlight.delete(key);
  }
}
