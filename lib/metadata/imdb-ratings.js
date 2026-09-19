import { getDatabase } from "../database/sqlite.js";
import { getImdbId } from "./tmdb.js";
import { getOmdbRating, isOmdbConfigured } from "./omdb.js";

export const IMDB_RATING_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_IMDB_RATING_ITEMS = 50;
const REFRESH_CONCURRENCY = 4;

export class ImdbRatingError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "ImdbRatingError";
    this.status = status;
  }
}

function itemKey(item) {
  return `${item.mediaType}:${item.tmdbId}`;
}

export function normalizeImdbRatingItems(value) {
  if (!Array.isArray(value)) throw new ImdbRatingError("items must be an array.");
  const unique = new Map();
  for (const item of value) {
    const mediaType = item?.mediaType;
    const tmdbId = Number(item?.tmdbId);
    if (!["movie", "tv"].includes(mediaType) || !Number.isInteger(tmdbId) || tmdbId < 1) {
      throw new ImdbRatingError("Each item must have a movie or tv mediaType and a positive integer tmdbId.");
    }
    unique.set(`${mediaType}:${tmdbId}`, { mediaType, tmdbId });
  }
  if (unique.size > MAX_IMDB_RATING_ITEMS) {
    throw new ImdbRatingError(`A maximum of ${MAX_IMDB_RATING_ITEMS} unique items is allowed.`);
  }
  return [...unique.values()];
}

function publicRating(item, rating) {
  return Number.isFinite(rating) ? { ...item, imdbRating: rating } : null;
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function getImdbRatings(value, {
  database = null,
  now = Date.now(),
  resolveImdbId = getImdbId,
  fetchRating = getOmdbRating,
  omdbConfigured = null,
  concurrency = REFRESH_CONCURRENCY,
} = {}) {
  const items = normalizeImdbRatingItems(value);
  if (items.length === 0) return [];
  const activeDatabase = database || getDatabase();

  const findCached = activeDatabase.prepare(`
    SELECT imdb_id, rating, refreshed_at
    FROM imdb_rating_cache
    WHERE media_type = ? AND tmdb_id = ?
  `);
  const upsert = activeDatabase.prepare(`
    INSERT INTO imdb_rating_cache (media_type, tmdb_id, imdb_id, rating, refreshed_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(media_type, tmdb_id) DO UPDATE SET
      imdb_id = excluded.imdb_id,
      rating = excluded.rating,
      refreshed_at = excluded.refreshed_at
  `);
  const cached = new Map(items.map((item) => [
    itemKey(item),
    findCached.get(item.mediaType, item.tmdbId) || null,
  ]));

  if (!(omdbConfigured ?? isOmdbConfigured())) {
    return items.map((item) => publicRating(item, cached.get(itemKey(item))?.rating)).filter(Boolean);
  }

  const cutoff = now - IMDB_RATING_CACHE_TTL_MS;
  const ratings = await mapWithConcurrency(items, concurrency, async (item) => {
    const previous = cached.get(itemKey(item));
    if (previous && previous.refreshed_at >= cutoff) return publicRating(item, previous.rating);

    try {
      const imdbId = previous?.imdb_id || await resolveImdbId(item.mediaType, item.tmdbId);
      if (!imdbId) {
        upsert.run(item.mediaType, item.tmdbId, null, null, now);
        return null;
      }
      const rating = await fetchRating(imdbId);
      upsert.run(item.mediaType, item.tmdbId, imdbId, rating, now);
      return publicRating(item, rating);
    } catch {
      return publicRating(item, previous?.rating);
    }
  });

  return ratings.filter(Boolean);
}
