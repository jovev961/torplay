import { saveSearchResult } from "../search/result-store.js";
import { filterAndRankResults, searchContext } from "../search/processing.js";
import { readUsenetConfig } from "./config.js";
import { searchNewznab } from "./newznab.js";

export async function findUsenetSources(mediaContext, dependencies = {}) {
  const config = await (dependencies.readConfig || readUsenetConfig)();
  if (!config.enabled || !config.indexers.length) return [];
  const context = searchContext(mediaContext);
  const settled = await Promise.allSettled(config.indexers.map((indexer) =>
    (dependencies.search || searchNewznab)(indexer, mediaContext, { signal: dependencies.signal })));
  dependencies.signal?.throwIfAborted();
  const candidates = settled.filter((item) => item.status === "fulfilled")
    .flatMap((item) => item.value);
  const unique = new Map();
  for (const candidate of candidates) unique.set(`${candidate.indexerId}:${candidate.guid || candidate.nzbUrl}`, candidate);
  return filterAndRankResults([...unique.values()], context).map((candidate) => ({
    id: saveSearchResult({ kind: "nzb", indexerId: candidate.indexerId,
      nzbUrl: candidate.nzbUrl, title: candidate.title,
      mediaContext: mediaContext.tmdbId ? mediaContext : null }),
    kind: "nzb", title: candidate.title, size: candidate.size,
    age: candidate.age || null, category: candidate.category,
    indexer: candidate.indexer, canStart: true,
  }));
}
