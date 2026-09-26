import { searchConfiguredProvider } from "./provider.js";
import { filterAndRankResults, searchContext, uniqueResults } from "./processing.js";
import { getSearchResult, saveSearchResult, updateSearchResult } from "./result-store.js";
import { validateStreamableResults } from "./streamable.js";
import { startPlaybackSource } from "../debrid/session.js";
import { inferMediaBadges } from "../video/media-capabilities.js";

const MAX_VISIBLE_RESULTS = 20;

function movieSearchTitles(mediaContext, context) {
  const original = typeof mediaContext.originalTitle === "string"
    ? mediaContext.originalTitle.trim() : "";
  if (context.type !== "movie" || !original || original.length > 200
    || original.normalize("NFKC").toLowerCase() === context.query.normalize("NFKC").toLowerCase()) {
    return [context.query];
  }
  return [context.query, original];
}

function interleaveMatches(lists) {
  const matches = [];
  const seen = new Set();
  const longest = Math.max(...lists.map((list) => list.length));
  for (let rank = 0; rank < longest; rank += 1) {
    for (const list of lists) {
      const candidate = list[rank];
      if (candidate && !seen.has(candidate)) {
        matches.push(candidate);
        seen.add(candidate);
      }
    }
  }
  return matches;
}

function rankCandidates(candidates, context, titles) {
  const unique = uniqueResults(filterAndRankResults(candidates, { ...context, aliases: titles.slice(1) }));
  return titles.length === 1 ? filterAndRankResults(unique, context)
    : interleaveMatches(titles.map((title) => filterAndRankResults(unique, { ...context, query: title })));
}

function publicResult(candidate, mediaContext, id = null) {
  const source = {
    infoHash: candidate.infoHash || null,
    magnet: candidate.source?.magnet || null,
    downloadUrl: candidate.source?.downloadUrl || null,
    resolver: candidate.source?.resolver || null,
    releaseName: candidate.title,
    ...(mediaContext.tmdbId ? { mediaContext } : {}),
  };
  if (id) updateSearchResult(id, source);
  // Explicit projection prevents adapter payloads or credentials reaching clients.
  return {
    id: id || saveSearchResult(source),
    title: candidate.title,
    size: candidate.size,
    seeders: candidate.seeders,
    infoHash: candidate.infoHash,
    indexer: candidate.indexer,
    providerId: candidate.providerId,
    providerName: candidate.providerName,
    leechers: candidate.leechers ?? null,
    quality: candidate.quality ?? null,
    resolution: candidate.resolution ?? null,
    codec: candidate.codec ?? null,
    media: candidate.media ?? null,
    mediaBadges: inferMediaBadges(candidate.title),
    hasMagnet: Boolean(source.magnet),
    canStart: Boolean(source.magnet || source.downloadUrl || source.resolver),
  };
}

export async function findAuthorizedSources(mediaContext, dependencies = {}) {
  const context = searchContext(mediaContext);
  const titles = movieSearchTitles(mediaContext, context);
  const options = {
    providers: dependencies.providers,
    timeoutMs: dependencies.timeoutMs,
    onFailure: dependencies.onFailure,
    usePersistentCache: dependencies.usePersistentCache,
    cacheDatabase: dependencies.cacheDatabase,
    now: dependencies.now,
    signal: dependencies.signal,
    onBatch: dependencies.onBatch,
    onTiming: dependencies.onTiming,
    cacheOnly: dependencies.cacheOnly,
    refresh: dependencies.refresh,
  };
  const searched = await Promise.allSettled(titles.map((title) => searchConfiguredProvider({
    ...mediaContext, title, type: context.type,
    season: context.season, episode: context.episode,
  }, options)));
  if (searched.every((result) => result.status === "rejected")) throw searched[0].reason;
  const ranked = rankCandidates(searched.filter((result) => result.status === "fulfilled")
    .flatMap((result) => result.value), context, titles);
  const matches = ranked.map((candidate) => publicResult(candidate, mediaContext));
  return validateStreamableResults(matches, context, dependencies.inspectSource);
}

export async function findAuthorizedSourcesProgressive(mediaContext, dependencies = {}) {
  const started = performance.now();
  const context = searchContext(mediaContext);
  const titles = movieSearchTitles(mediaContext, context);
  const batches = new Map();
  const ids = new Map();
  const cacheTimes = new Map();
  const publicCandidate = (candidate) => {
    const key = candidate.infoHash || `${candidate.title.toLowerCase()}\u0000${candidate.size}`;
    const previous = ids.get(key);
    const source = candidate.source || {};
    const sameSource = previous?.providerId === candidate.providerId
      && previous?.magnet === source.magnet && previous?.downloadUrl === source.downloadUrl
      && previous?.resolver === source.resolver;
    const result = publicResult(candidate, mediaContext, sameSource ? previous.id : null);
    ids.set(key, { id: result.id, providerId: candidate.providerId,
      magnet: source.magnet, downloadUrl: source.downloadUrl, resolver: source.resolver });
    if (Number.isFinite(candidate.cacheCreatedAt)) cacheTimes.set(result.id, candidate.cacheCreatedAt);
    else cacheTimes.delete(result.id);
    return result;
  };
  const cacheInfo = (results) => {
    const cached = results.map((result) => cacheTimes.get(result.id)).filter(Number.isFinite);
    if (!cached.length) return null;
    return {
      status: cached.length === results.length ? "all" : "partial",
      oldestCreatedAt: Math.min(...cached),
    };
  };
  let visible = [];
  const publish = ({ providerId, title, candidates }) => {
    if (dependencies.signal?.aborted) return;
    batches.set(`${providerId}\u0000${title}`, candidates);
    const ranked = rankCandidates([...batches.values()].flat(), context, titles);
    visible = ranked.slice(0, MAX_VISIBLE_RESULTS).map((candidate) => {
      const result = publicCandidate(candidate);
      const source = getSearchResult(result.id);
      return { ...result, verification: source?.downloadUrl || source?.resolver ? "checking" : "magnet",
        streamable: false, canStart: !source?.downloadUrl && !source?.resolver && Boolean(source?.magnet) };
    });
    dependencies.onResults?.(visible, cacheInfo(visible));
  };
  const searched = await Promise.allSettled(titles.map((title) => searchConfiguredProvider({
    ...mediaContext, title, type: context.type, season: context.season, episode: context.episode,
  }, { ...dependencies, onBatch: publish })));
  dependencies.onTiming?.({ phase: "provider-search", elapsedMs: Math.round(performance.now() - started) });
  if (dependencies.signal?.aborted) throw dependencies.signal.reason || new DOMException("Search cancelled.", "AbortError");
  if (searched.every((result) => result.status === "rejected") && !batches.size) throw searched[0].reason;
  const finalRanked = rankCandidates([...batches.values()].flat(), context, titles);
  const finalMatches = finalRanked.slice(0, MAX_VISIBLE_RESULTS).map(publicCandidate);
  const pending = new Map(finalMatches.map((result) => [result.id, {
    ...result, verification: getSearchResult(result.id)?.downloadUrl || getSearchResult(result.id)?.resolver
      ? "checking" : "magnet", streamable: false,
    canStart: !getSearchResult(result.id)?.downloadUrl && !getSearchResult(result.id)?.resolver
      && Boolean(getSearchResult(result.id)?.magnet),
  }]));
  dependencies.onResults?.([...pending.values()], cacheInfo([...pending.values()]));
  const validationStarted = performance.now();
  const validated = await validateStreamableResults(finalMatches, context,
    dependencies.inspectSource, { signal: dependencies.signal, onResult: (result, id) => {
      if (result) pending.set(id, result);
      else pending.delete(id);
      dependencies.onResults?.([...pending.values()], cacheInfo([...pending.values()]));
    } });
  dependencies.onTiming?.({ phase: "validation", elapsedMs: Math.round(performance.now() - validationStarted) });
  dependencies.onResults?.(validated, cacheInfo(validated));
  return validated;
}

export async function startBestVerifiedSource(mediaContext, dependencies = {}) {
  const results = await findAuthorizedSources(mediaContext, dependencies);
  const verified = results.filter((result) => result.verification === "verified"
    && !result.manualSelectionRequired);
  let lastError = null;
  for (const result of verified) {
    const source = getSearchResult(result.id);
    if (!source) continue;
    try {
      return { result, session: await (dependencies.startSource || startPlaybackSource)(source) };
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  return null;
}
