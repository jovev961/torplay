import { resolve } from "../sources/results.js";
import { inspectTorrentSource } from "./manager.js";
import { withDeadline } from "../network/request.js";

export function pendingCandidates(candidates) {
  return candidates.map((candidate) => {
    const source = resolve(candidate.id, "torrent");
    const checking = Boolean(source?.resolver || source?.downloadUrl);
    return { ...candidate, streamable: false, verification: checking ? "checking" : "magnet", canStart: !checking && Boolean(source?.magnet) };
  });
}

// File suitability is acquisition behavior; discovery never imports the torrent engine.
export async function inspectCandidates(candidates, context, { signal, inspect = inspectTorrentSource, onUpdate } = {}) {
  const rows = new Map(pendingCandidates(candidates.slice(0, 20)).map((candidate) => [candidate.id, candidate]));
  const ordered = [...rows.keys()];
  let cursor = 0;
  function publish() {
    signal?.throwIfAborted();
    const items = ordered.map((id) => rows.get(id)).filter(Boolean);
    onUpdate?.(items);
    return items;
  }
  await Promise.all(Array.from({ length: Math.min(4, ordered.length) }, async () => {
    while (cursor < ordered.length) {
      signal?.throwIfAborted();
      const id = ordered[cursor++];
      const row = rows.get(id);
      const source = resolve(id, "torrent");
      if (!source) { rows.delete(id); continue; }
      if (row.verification !== "checking") continue;
      try {
        const inspection = await withDeadline((boundedSignal) => inspect(source, context, { signal: boundedSignal }), { signal, timeoutMs: 30_000 });
        signal?.throwIfAborted();
        if (inspection) rows.set(id, { ...row, canStart: true, streamable: true, verification: "verified",
          ...(inspection.manualSelectionRequired ? { manualSelectionRequired: true } : {}) });
        else rows.delete(id);
      } catch {
        signal?.throwIfAborted();
        if (source.magnet) rows.set(id, { ...row, canStart: true, streamable: false, verification: "magnet" });
        else rows.delete(id);
      }
      publish();
    }
  }));
  return publish();
}
