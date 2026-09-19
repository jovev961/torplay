import { searchConfiguredProvider } from "./provider.js";
import { filterAndRankResults, searchContext, uniqueResults } from "./processing.js";
import { getSearchResult, saveSearchResult } from "./result-store.js";
import { validateStreamableResults } from "./streamable.js";
import { startTorrent } from "../torrent/manager.js";

export async function findAuthorizedSources(mediaContext, dependencies = {}) {
  const context = searchContext(mediaContext);
  const candidates = await (dependencies.searchProvider || searchConfiguredProvider)({
    ...mediaContext, title: context.query, type: context.type,
    season: context.season, episode: context.episode,
  });
  const matches = filterAndRankResults(uniqueResults(candidates), context).map((candidate) => {
    const source = {
      magnet: candidate.source?.magnet || null,
      downloadUrl: candidate.source?.downloadUrl || null,
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
      hasMagnet: Boolean(source.magnet),
      canStart: Boolean(source.magnet || source.downloadUrl),
    };
  });
  return validateStreamableResults(matches, context, dependencies.inspectSource);
}

export async function startBestVerifiedSource(mediaContext, dependencies = {}) {
  const results = await findAuthorizedSources(mediaContext, dependencies);
  const verified = results.filter((result) => result.verification === "verified");
  let lastError = null;
  for (const result of verified) {
    const source = getSearchResult(result.id);
    if (!source) continue;
    try {
      return { result, session: await (dependencies.startSource || startTorrent)(source) };
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  return null;
}
