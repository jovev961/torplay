import { searchJackett } from "./jackett.js";
import { getSearchResult, updateSearchResult } from "./result-store.js";
import { validateStreamableResults } from "./streamable.js";
import { startTorrent } from "../torrent/manager.js";

export async function findAuthorizedSources(mediaContext) {
  const options = {
    type: mediaContext.type,
    season: mediaContext.season,
    episode: mediaContext.episode,
  };
  const matches = await searchJackett(mediaContext.title, options);
  const results = await validateStreamableResults(matches, options);
  if (mediaContext.tmdbId) {
    for (const result of results) updateSearchResult(result.id, { mediaContext });
  }
  return results;
}

export async function startBestVerifiedSource(mediaContext) {
  const results = await findAuthorizedSources(mediaContext);
  const verified = results.filter((result) => result.verification === "verified");
  let lastError = null;
  for (const result of verified) {
    const source = getSearchResult(result.id);
    if (!source) continue;
    try {
      return { result, session: await startTorrent(source) };
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  return null;
}
