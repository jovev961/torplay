import { getSearchResult } from "./result-store.js";
import { inspectTorrentSource } from "../torrent/manager.js";

const MAX_VALIDATION_RESULTS = 20;
const VALIDATION_CONCURRENCY = 4;

export async function validateStreamableResults(
  results,
  context = {},
  inspectSource = inspectTorrentSource,
) {
  const candidates = results.slice(0, MAX_VALIDATION_RESULTS);
  const validated = new Array(candidates.length);
  let cursor = 0;

  function magnetFallback(result, source) {
    if (!source.magnet || !result.infoHash) return null;
    return {
      ...result,
      streamable: false,
      verification: "magnet",
    };
  }

  async function worker() {
    while (cursor < candidates.length) {
      const index = cursor;
      cursor += 1;
      const result = candidates[index];
      const source = getSearchResult(result.id);
      if (!source) continue;

      if (!source.downloadUrl && !source.resolver) {
        validated[index] = magnetFallback(result, source);
        continue;
      }

      try {
        const inspection = await inspectSource(source, context);
        if (inspection) {
          validated[index] = {
            ...result,
            streamable: true,
            verification: "verified",
            ...(inspection.manualSelectionRequired ? { manualSelectionRequired: true } : {}),
          };
        }
      } catch {
        validated[index] = magnetFallback(result, source);
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(VALIDATION_CONCURRENCY, candidates.length) },
      () => worker(),
    ),
  );
  const available = validated.filter(Boolean);
  return [
    ...available.filter((result) => result.verification === "verified"),
    ...available.filter((result) => result.verification === "magnet"),
  ];
}
