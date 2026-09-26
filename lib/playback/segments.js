import { readPersistentCache, writePersistentCache } from "../cache/persistent.js";
import { getImdbId } from "../metadata/tmdb.js";

const TYPES = ["intro", "recap", "outro", "preview"];
const INTRODB_TYPES = ["intro", "recap", "outro"];
const EMPTY = Object.freeze({ intro: null, recap: null, outro: null, preview: null });
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const CACHE_NAMESPACE = "episode-segments-v2";

function normalizedRange(rawStart, rawEnd, durationMs, source, scale = 1) {
  if (rawStart == null || rawEnd == null) return null;
  const startMs = Math.round(Number(rawStart) * scale);
  const endMs = Math.round(Number(rawEnd) * scale);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)
    || startMs < 0 || startMs >= durationMs || endMs <= startMs || endMs > durationMs + 1000) return null;
  return { startMs, endMs: Math.min(endMs, durationMs), source };
}

export function normalizeSegments(payload, duration) {
  const result = { ...EMPTY };
  if (!Number.isFinite(duration) || duration <= 0 || !payload?.segments) return result;
  for (const type of TYPES) {
    const segment = payload.segments[type];
    if (!segment || !["exact", "shifted"].includes(segment.match)) continue;
    result[type] = normalizedRange(segment.start_ms, segment.end_ms, duration * 1000, "skipdb");
  }
  return result;
}

function matchesIntroDbEpisode(payload, { imdbId, season, episode }) {
  return payload?.imdb_id === imdbId && payload.season != null && payload.episode != null
    && Number(payload.season) === season && Number(payload.episode) === episode
    && payload.is_movie !== true;
}

export function normalizeIntroDbSegments(payload, duration, { imdbId, season, episode }) {
  const result = { ...EMPTY };
  if (!Number.isFinite(duration) || duration <= 0
    || !matchesIntroDbEpisode(payload, { imdbId, season, episode })) return result;
  for (const type of INTRODB_TYPES) {
    const segment = payload[type];
    if (segment) result[type] = normalizedRange(
      segment.start_sec, segment.end_sec, duration * 1000, "introdb", 1000,
    );
  }
  return result;
}

async function requestSegments(fetchSegments, url) {
  try {
    const response = await fetchSegments(url, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return { ok: false, payload: null };
    return { ok: true, payload: await response.json() };
  } catch {
    return { ok: false, payload: null };
  }
}

export async function getEpisodeSegments({ tmdbId, season, episode, duration }, dependencies = {}) {
  const resolveImdbId = dependencies.resolveImdbId || getImdbId;
  const fetchSegments = dependencies.fetchSegments || fetch;
  const readCache = dependencies.readCache || readPersistentCache;
  const writeCache = dependencies.writeCache || writePersistentCache;
  const empty = { segments: { ...EMPTY }, attribution: "SkipDB and IntroDB" };
  let imdbId;
  try { imdbId = await resolveImdbId("tv", tmdbId); } catch { return empty; }
  if (!imdbId) return empty;
  const roundedDuration = Math.round(duration);
  const key = `${imdbId}:${season}:${episode}:${roundedDuration}`;
  const cached = readCache(CACHE_NAMESPACE, key);
  if (cached.hit) return { segments: cached.value, attribution: empty.attribution };

  const skipDbUrl = new URL("https://api.skipdb.tv/api/segments");
  skipDbUrl.searchParams.set("imdb_id", imdbId);
  skipDbUrl.searchParams.set("season", String(season));
  skipDbUrl.searchParams.set("episode", String(episode));
  skipDbUrl.searchParams.set("duration", String(roundedDuration));
  skipDbUrl.searchParams.set("adjust", "conservative");
  const skipDb = await requestSegments(fetchSegments, skipDbUrl);
  const segments = skipDb.ok ? normalizeSegments(skipDb.payload, duration) : { ...EMPTY };

  let introDbOk = true;
  if (INTRODB_TYPES.some((type) => !segments[type])) {
    const introDbUrl = new URL("https://api.introdb.app/segments");
    introDbUrl.searchParams.set("imdb_id", imdbId);
    introDbUrl.searchParams.set("season", String(season));
    introDbUrl.searchParams.set("episode", String(episode));
    const introDb = await requestSegments(fetchSegments, introDbUrl);
    introDbOk = introDb.ok && matchesIntroDbEpisode(introDb.payload, { imdbId, season, episode });
    if (introDbOk) {
      const fallback = normalizeIntroDbSegments(introDb.payload, duration, { imdbId, season, episode });
      for (const type of INTRODB_TYPES) segments[type] ||= fallback[type];
    }
  }

  if (skipDb.ok && skipDb.payload?.segments && introDbOk) {
    const hasSegments = TYPES.some((type) => segments[type]);
    writeCache(CACHE_NAMESPACE, key, segments, { ttlMs: hasSegments ? DAY_MS : HOUR_MS });
  }
  return { segments, attribution: empty.attribution };
}
