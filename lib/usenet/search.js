import { rememberNzb } from "../sources/results.js";
import { rankCandidates } from "../sources/relevance.js";
import { mediaContext } from "../sources/contract.js";
import { readUsenetConfig } from "./config.js";
import { searchNewznab } from "./newznab.js";

export async function findUsenetSources(input, dependencies = {}) {
  const config = await (dependencies.readConfig || readUsenetConfig)();
  if (!config.enabled || !config.indexers.length) return [];
  const context = mediaContext(input);
  const settled = await Promise.allSettled(config.indexers.map((indexer) =>
    (dependencies.search || searchNewznab)(indexer, context, { signal: dependencies.signal })));
  dependencies.signal?.throwIfAborted();
  const candidates = settled.filter((item) => item.status === "fulfilled").flatMap((item) => item.value);
  return rankCandidates(candidates, context).map((candidate) => ({
    id: rememberNzb(candidate, context), kind: "nzb", title: candidate.title, size: candidate.size,
    age: candidate.age || null, category: candidate.category,
    indexer: candidate.indexer, canStart: true,
  }));
}
