import { searchConfiguredProvider } from "./provider.js";
import { filterAndRankResults, searchContext, uniqueResults } from "./processing.js";
import { getSearchResult, saveSearchResult } from "./result-store.js";
import { validateStreamableResults } from "./streamable.js";
import { startPlaybackSource } from "../debrid/session.js";

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
  };
  const searched = await Promise.allSettled(titles.map((title) => searchConfiguredProvider({
    ...mediaContext, title, type: context.type,
    season: context.season, episode: context.episode,
  }, options)));
  if (searched.every((result) => result.status === "rejected")) throw searched[0].reason;
  const candidates = uniqueResults(filterAndRankResults(
    searched.filter((result) => result.status === "fulfilled").flatMap((result) => result.value),
    { ...context, aliases: titles.slice(1) },
  ));
  const ranked = titles.length === 1
    ? filterAndRankResults(candidates, context)
    : interleaveMatches(titles.map((title) => filterAndRankResults(candidates,
      { ...context, query: title })));
  const matches = ranked.map((candidate) => {
    const source = {
      infoHash: candidate.infoHash || null,
      magnet: candidate.source?.magnet || null,
      downloadUrl: candidate.source?.downloadUrl || null,
      resolver: candidate.source?.resolver || null,
      releaseName: candidate.title,
      ...(mediaContext.tmdbId ? { mediaContext } : {}),
    };
    // Explicit projection prevents adapter payloads or credentials reaching clients.
    return {
      id: saveSearchResult(source),
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
      hasMagnet: Boolean(source.magnet),
      canStart: Boolean(source.magnet || source.downloadUrl || source.resolver),
    };
  });
  return validateStreamableResults(matches, context, dependencies.inspectSource);
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
