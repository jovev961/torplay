import { getSearchResult } from "../search/result-store.js";
import { classifyVideoFile, resolveTorrentInput } from "../torrent/manager.js";
import { findLargestFile } from "../video/episode.js";
import { resolveEpisodeFile } from "../video/episode-mapping.js";
import { readDebridConfig } from "./config.js";
import { makeDebridProvider } from "./session.js";

function playableFile(availability, source, infoHash, database) {
  if (availability?.status !== "available") return false;
  const files = (availability.files || []).filter((file) =>
    classifyVideoFile(file.name) && Number.isSafeInteger(Number(file.size)) && Number(file.size) > 0);
  if (source.mediaContext?.type === "show") {
    const context = source.mediaContext;
    return Boolean(resolveEpisodeFile(infoHash, context, files.map((file) => ({
      ...file, relativePath: file.path,
    })), context.season, context.episode, { allowSingleFileFallback: false, database }));
  }
  return Boolean(findLargestFile(files));
}

export async function inspectTorrentAvailability(resultIds, { resolveUnknown = false } = {}, dependencies = {}) {
  if (!Array.isArray(resultIds) || resultIds.length < 1 || resultIds.length > 20
    || resultIds.some((id) => typeof id !== "string") || new Set(resultIds).size !== resultIds.length
    || (resolveUnknown && resultIds.length !== 1)) {
    throw Object.assign(new Error("Choose up to 20 distinct torrent results."), { status: 400 });
  }
  const sources = resultIds.map((id) => getSearchResult(id));
  if (sources.some((source) => !source)) {
    throw Object.assign(new Error("A torrent result expired. Search again."), { status: 404 });
  }
  const config = dependencies.config || await readDebridConfig();
  const providers = config.mode === "local" ? [] : config.priority.filter((id) => config.credentials[id]);
  const localAllowed = config.mode === "local"
    || (config.mode !== "debrid-only" && config.localFallback !== false);
  const rows = await Promise.all(sources.map(async (source) => {
    let infoHash = source.infoHash;
    if (resolveUnknown) {
      try { infoHash = (await (dependencies.resolveSource || resolveTorrentInput)(source)).infoHash; }
      catch { infoHash = null; /* A torrent may still be playable locally. */ }
    }
    return { source, infoHash: /^[a-f0-9]{40}$/i.test(infoHash || "") ? infoHash.toLowerCase() : null };
  }));
  const results = Object.fromEntries(resultIds.map((id) => [id, {
    availability: Object.fromEntries(providers.map((provider) => [provider, "unknown"])),
  }]));
  const hashes = [...new Set(rows.map((row) => row.infoHash).filter(Boolean))];
  for (const id of providers) {
    if (!hashes.length) continue;
    const provider = (dependencies.providerFactory || makeDebridProvider)(id, config.credentials[id], dependencies);
    let checked = {};
    try {
      if (id === "real-debrid" && typeof provider.checkAvailabilityMany === "function") {
        checked = await provider.checkAvailabilityMany(hashes);
      } else {
        let cursor = 0;
        const workers = Array.from({ length: Math.min(4, hashes.length) }, async () => {
          while (cursor < hashes.length) {
            const hash = hashes[cursor++];
            try { checked[hash] = await provider.checkAvailability({ infoHash: hash }); }
            catch { checked[hash] = null; }
          }
        });
        await Promise.all(workers);
      }
    } catch { /* Provider failures remain unknown, never "not ready". */ }
    rows.forEach(({ source, infoHash }, index) => {
      if (!infoHash || !checked[infoHash]) return;
      results[resultIds[index]].availability[id] = playableFile(checked[infoHash], source,
        infoHash, dependencies.database)
        ? "ready" : "not-ready";
    });
  }
  return { providers, localAllowed, results };
}
