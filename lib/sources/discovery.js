import { createHash } from "node:crypto";
import { configuredSources, configurationFingerprint } from "./configuration.js";
import { mediaContext, normalize, SourceError, diagnostic } from "./contract.js";
import { rankCandidates, candidateKey } from "./relevance.js";
import { rememberTorrent } from "./results.js";
import { searchNative } from "./native.js";
import { searchTorznab, jackettSource } from "./torznab.js";
import { searchCardigann } from "./cardigann/engine.js";
import { withDeadline } from "../network/request.js";
import { readPersistentCache, writePersistentCache } from "../cache/persistent.js";
import { inferMediaBadges } from "../video/media-capabilities.js";

const CACHE = "source-discovery";
const CACHE_TTL = 24 * 60 * 60_000;

function publicCandidate(candidate, id) {
  return { id, kind: "torrent", title: candidate.title, size: candidate.size, seeders: candidate.seeders,
    leechers: candidate.leechers, sourceId: candidate.sourceId, sourceName: candidate.sourceName,
    origin: candidate.origin, quality: candidate.quality, resolution: candidate.resolution, codec: candidate.codec,
    mediaBadges: inferMediaBadges(candidate.title), canStart: true };
}

function cacheKey(source, context, environment) {
  return createHash("sha256").update(JSON.stringify({ configuration: configurationFingerprint(source, environment), context })).digest("hex");
}

function replayable(candidate) {
  if (!candidate.infoHash) return null;
  // Explicit projection: cached data never contains provider URLs, cookies or functions.
  return { title: candidate.title, size: candidate.size, seeders: candidate.seeders, leechers: candidate.leechers,
    infoHash: candidate.infoHash, origin: candidate.origin, quality: candidate.quality,
    resolution: candidate.resolution, codec: candidate.codec, media: candidate.media,
    inspect: Boolean(candidate.locator.downloadUrl || candidate.locator.resolve) };
}

async function familySearch(source, context, options) {
  if (source.configurationError) throw new SourceError("CONFIGURATION_REQUIRED", "The saved source requires correction.");
  if (source.kind === "native") return searchNative(source, context, options);
  if (source.kind === "cardigann") return searchCardigann(source, context, options);
  if (source.kind === "torznab" || source.kind === "jackett") return searchTorznab(source.kind === "jackett" ? jackettSource(source, options.environment) : source, context, options);
  throw new SourceError("CONFIGURATION_REQUIRED", "The source kind is unsupported.");
}

export async function search(input, options = {}) {
  const context = mediaContext(input);
  const environment = options.environment || process.env;
  options.signal?.throwIfAborted();
  const sources = options.sources || configuredSources(environment);
  if (!sources.length && !options.cacheOnly) throw new SourceError("NO_TORRENT_SOURCES", "Add and enable a torrent source in Settings before searching.", 503);
  const identities = new Set();
  for (const source of sources) {
    if (!source || !source.id || identities.has(source.id)) throw new SourceError("CONFIGURATION_REQUIRED", "Source identities must be unique.", 503);
    identities.add(source.id);
  }
  const batches = new Map();
  const privateIds = new Map();
  const diagnostics = new Map();
  const times = new Map();
  const cacheOptions = { database: options.cacheDatabase, now: options.now ?? Date.now(), ttlMs: CACHE_TTL };
  const caching = options.usePersistentCache ?? !options.sources;
  let current = { candidates: [], diagnostics: [], cache: null };
  function publish() {
    options.signal?.throwIfAborted();
    const candidates = rankCandidates([...batches.values()].flat(), context).slice(0, 20).map((candidate) => {
      const key = `${candidate.sourceId}:${candidateKey(candidate)}`;
      const previous = privateIds.get(key);
      const locator = candidate.locator;
      const same = previous && previous.magnet === locator.magnet && previous.downloadUrl === locator.downloadUrl && previous.resolve === locator.resolve;
      const id = same ? previous.id : rememberTorrent(candidate, context);
      if (!same) privateIds.set(key, { id, ...locator });
      if (candidate.cachedAt != null) times.set(id, candidate.cachedAt); else times.delete(id);
      return publicCandidate(candidate, id);
    });
    const cached = candidates.map((candidate) => times.get(candidate.id)).filter(Number.isFinite);
    current = { candidates, diagnostics: [...diagnostics.values()], cache: cached.length ? {
      status: cached.length === candidates.length ? "all" : "partial", oldestCreatedAt: Math.min(...cached),
    } : null };
    options.onUpdate?.(current);
    return current;
  }
  const settled = await Promise.allSettled(sources.map(async (source) => {
    options.signal?.throwIfAborted();
    const started = performance.now();
    const key = cacheKey(source, context, environment);
    if (caching && !options.refresh) {
      const cache = readPersistentCache(CACHE, key, cacheOptions);
      if (cache.hit && Array.isArray(cache.value?.candidates)) {
        const candidates = cache.value.candidates.map((entry) => normalize({ ...entry,
          locator: { magnet: `magnet:?xt=urn:btih:${entry.infoHash}` } }, source)).filter(Boolean)
          .map((candidate) => ({ ...candidate, cachedAt: cache.createdAt }));
        batches.set(source.id, candidates);
        diagnostics.set(source.id, { sourceId: source.id, sourceName: source.name, status: "ready", message: "Cached matching results restored.", cached: true, count: candidates.length });
        publish();
        if (options.cacheOnly || cache.value.complete) return candidates;
      }
    }
    if (options.cacheOnly) return [];
    try {
      const candidates = await withDeadline(async (signal) => {
        const variants = await Promise.allSettled(context.aliases.map((title) => familySearch(source, { ...context, title }, { ...options, environment, signal })));
        signal.throwIfAborted();
        if (variants.every((variant) => variant.status === "rejected")) throw variants[0].reason;
        return rankCandidates(variants.filter((variant) => variant.status === "fulfilled").flatMap((variant) => variant.value)
          .map((raw) => normalize(raw, source)).filter(Boolean), context).slice(0, 200);
      }, { signal: options.signal, timeoutMs: options.timeoutMs ?? 120_000 });
      options.signal?.throwIfAborted();
      batches.set(source.id, candidates);
      diagnostics.set(source.id, { sourceId: source.id, sourceName: source.name, status: "ready", message: "Source search completed.",
        count: rankCandidates(candidates, context).length, elapsedMs: Math.round(performance.now() - started) });
      if (caching) {
        const replay = candidates.map(replayable).filter(Boolean);
        writePersistentCache(CACHE, key, { candidates: replay,
          complete: replay.length === candidates.length && replay.every((candidate) => !candidate.inspect) }, cacheOptions);
      }
      publish();
      return candidates;
    } catch (error) {
      options.signal?.throwIfAborted();
      diagnostics.set(source.id, { sourceId: source.id, sourceName: source.name, ...diagnostic(error), elapsedMs: Math.round(performance.now() - started) });
      // Cached previews remain selectable as magnets; failures never claim live success.
      publish();
      throw error;
    }
  }));
  options.signal?.throwIfAborted();
  const final = publish();
  if (sources.length && settled.every((result) => result.status === "rejected") && !final.candidates.length) {
    const timedOut = [...diagnostics.values()].every((item) => item.status === "timed-out");
    throw Object.assign(new SourceError("SOURCES_UNAVAILABLE", timedOut ? "All source searches timed out." : "No source could complete the search.", timedOut ? 504 : 502),
      { diagnostics: final.diagnostics });
  }
  return final;
}
