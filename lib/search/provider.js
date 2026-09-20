import { searchJackett } from "./jackett.js";
import { normalizeCandidate } from "./contract.js";
import { TorrentSearchError } from "./processing.js";
import { customProviderAdapter, effectiveCustomProviders, readCustomProviders } from "../settings/torrent-providers.js";
import { customTorznabAdapter } from "./torznab.js";
import { readPersistentCache, writePersistentCache } from "../cache/persistent.js";
import { jackettIsConfigured, providerIds } from "./provider-config.js";

// The configured adapter is selected here, never by search or playback consumers.
const providersById = [{ id: "jackett", name: "Jackett", search: searchJackett }];
export const PROVIDER_RESULT_CACHE_TTL_MS = 2 * 60 * 1_000;
export function configuredProviders(environment = process.env) {
  const savedCustom = readCustomProviders(environment);
  const custom = effectiveCustomProviders(environment, savedCustom).map((provider) => (
    customProviderAdapter(provider) || customTorznabAdapter(provider)
  ));
  const explicit = environment.TORPLAY_SEARCH_PROVIDERS;
  const ids = explicit !== undefined
    ? providerIds(explicit)
    : [...(jackettIsConfigured(environment) ? ["jackett"] : []), ...custom.map((item) => item.id)];
  return ids.filter((id) => !savedCustom.some((item) => item.id === id && !item.enabled)).map((id) => {
    const provider = [...providersById, ...custom].find((item) => item.id === id);
    if (!provider) throw new TorrentSearchError("Unknown torrent search provider ID.", 503);
    return provider;
  });
}

function providerCacheKey(provider, context) {
  return JSON.stringify({
    provider: provider.id,
    title: context.title,
    type: context.type,
    tmdbId: context.tmdbId ?? null,
    imdbId: context.imdbId ?? null,
    year: context.year ?? null,
    season: context.season ?? null,
    episode: context.episode ?? null,
    categories: Array.isArray(context.categories) ? context.categories : [],
  });
}

function safeCacheValue(candidates) {
  if (!candidates.every((candidate) => typeof candidate.infoHash === "string"
    && /^[a-f\d]{40}$|^[a-z2-7]{32}$/i.test(candidate.infoHash))) return null;
  return candidates.map((candidate) => ({
    ...candidate,
    source: {
      magnet: `magnet:?xt=urn:btih:${candidate.infoHash}`,
      downloadUrl: null,
    },
  }));
}

async function execute(provider, context, timeoutMs, cacheOptions) {
  const cacheKey = providerCacheKey(provider, context);
  if (cacheOptions) {
    const cached = readPersistentCache("provider-results", cacheKey, cacheOptions);
    if (cached.hit && Array.isArray(cached.value)) {
      const normalized = cached.value.map((candidate) => normalizeCandidate(candidate, provider)).filter(Boolean);
      if (normalized.length === cached.value.length) return normalized;
    }
  }
  const controller = new AbortController();
  let timer;
  try {
    const candidates = await Promise.race([
      Promise.resolve().then(() => provider.search(context, { signal: controller.signal })).then((items) => {
        if (!Array.isArray(items)) throw new Error("Invalid provider response");
        return items.map((item) => normalizeCandidate(item, provider)).filter(Boolean);
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(Object.assign(new Error("Provider deadline exceeded"), { status: 504 }));
        }, timeoutMs);
      }),
    ]);
    const cacheValue = cacheOptions ? safeCacheValue(candidates) : null;
    if (cacheValue) {
      writePersistentCache("provider-results", cacheKey, cacheValue, {
        ...cacheOptions,
        ttlMs: PROVIDER_RESULT_CACHE_TTL_MS,
      });
    }
    return candidates;
  } finally {
    clearTimeout(timer);
  }
}

export async function searchConfiguredProvider(mediaContext, options = {}) {
  const configuredSelection = options.providers === undefined;
  const providers = configuredSelection ? configuredProviders() : options.providers;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const onFailure = options.onFailure
    || ((failure) => console.warn("[torrent-search]", failure.providerId, failure.category));
  const usePersistentCache = options.usePersistentCache ?? configuredSelection;
  const cacheOptions = usePersistentCache
    ? { database: options.cacheDatabase, now: options.now ?? Date.now() }
    : null;
  if (!providers.length) {
    throw new TorrentSearchError(
      "Add a torrent source in Settings before searching.",
      503,
      "NO_TORRENT_SOURCES",
    );
  }
  const ids = new Set();
  for (const provider of providers) {
    if (!provider || !/^[a-z0-9][a-z0-9._-]*$/i.test(provider.id || "")
      || !provider.name || typeof provider.search !== "function" || ids.has(provider.id)) {
      throw new TorrentSearchError("Invalid torrent search provider configuration.", 503);
    }
    ids.add(provider.id);
  }
  const settled = await Promise.allSettled(
    providers.map((provider) => execute(provider, mediaContext, timeoutMs, cacheOptions)),
  );
  const failures = [];
  settled.forEach((item, index) => {
    if (item.status === "rejected") {
      const failure = { providerId: providers[index].id, category: item.reason?.status === 504 ? "timeout" : "failed" };
      failures.push(failure);
      onFailure(failure);
    }
  });
  if (failures.length === providers.length) {
    const timeout = failures.every((failure) => failure.category === "timeout");
    throw new TorrentSearchError(timeout ? "All torrent search providers timed out." : "No torrent search provider completed the search.", timeout ? 504 : 502);
  }
  return settled.filter((item) => item.status === "fulfilled").flatMap((item) => item.value);
}
