import { readPersistentCache, writePersistentCache } from "../cache/persistent.js";
import { getImdbId } from "../metadata/tmdb.js";

const TYPES = ["intro", "recap", "outro", "preview"];
const EMPTY = Object.freeze({ intro: null, recap: null, outro: null, preview: null });
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export function normalizeSegments(payload, duration) {
  const result = { ...EMPTY };
  if (!Number.isFinite(duration) || duration <= 0 || !payload?.segments) return result;
  for (const type of TYPES) {
    const segment = payload.segments[type];
    if (!segment || !["exact", "shifted"].includes(segment.match)) continue;
    const start = Number(segment.start_ms) / 1000;
    const end = Number(segment.end_ms) / 1000;
    if (!Number.isFinite(start) || !Number.isFinite(end)
      || start < 0 || start >= duration || end <= start || end > duration + 1) continue;
    result[type] = { start, end: Math.min(end, duration) };
  }
  return result;
}

export async function getEpisodeSegments({ tmdbId, season, episode, duration }, dependencies = {}) {
  const resolveImdbId = dependencies.resolveImdbId || getImdbId;
  const fetchSegments = dependencies.fetchSegments || fetch;
  const readCache = dependencies.readCache || readPersistentCache;
  const writeCache = dependencies.writeCache || writePersistentCache;
  const empty = { segments: { ...EMPTY }, attribution: "SkipDB" };
  let imdbId;
  try { imdbId = await resolveImdbId("tv", tmdbId); } catch { return empty; }
  if (!imdbId) return empty;
  const roundedDuration = Math.round(duration);
  const key = `${imdbId}:${season}:${episode}:${roundedDuration}`;
  const cached = readCache("skipdb-segments", key);
  if (cached.hit) return { segments: cached.value, attribution: "SkipDB" };
  const url = new URL("https://api.skipdb.tv/api/segments");
  url.searchParams.set("imdb_id", imdbId);
  url.searchParams.set("season", String(season));
  url.searchParams.set("episode", String(episode));
  url.searchParams.set("duration", String(roundedDuration));
  url.searchParams.set("adjust", "conservative");
  try {
    const response = await fetchSegments(url, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return empty;
    const payload = await response.json();
    const segments = normalizeSegments(payload, duration);
    const hasSegments = TYPES.some((type) => segments[type]);
    writeCache("skipdb-segments", key, segments, { ttlMs: hasSegments ? DAY_MS : HOUR_MS });
    return { segments, attribution: "SkipDB" };
  } catch {
    return empty;
  }
}
