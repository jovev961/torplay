import { searchConfiguredProvider } from "./provider.js";
import { filterAndRankResults, searchContext, uniqueResults } from "./processing.js";
import { getSearchResult, saveSearchResult } from "./result-store.js";
import { validateStreamableResults } from "./streamable.js";
import { startPlaybackSource } from "../debrid/session.js";

export async function findAuthorizedSources(mediaContext, dependencies = {}) {
  const context = searchContext(mediaContext);
  const candidates = await searchConfiguredProvider({
    ...mediaContext, title: context.query, type: context.type,
    season: context.season, episode: context.episode,
  }, {
    providers: dependencies.providers,
    timeoutMs: dependencies.timeoutMs,
    onFailure: dependencies.onFailure,
    usePersistentCache: dependencies.usePersistentCache,
    cacheDatabase: dependencies.cacheDatabase,
    now: dependencies.now,
  });
  const matches = filterAndRankResults(uniqueResults(candidates), context).map((candidate) => {
    const source = {
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
