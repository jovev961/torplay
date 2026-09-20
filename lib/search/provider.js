import { searchJackett } from "./jackett.js";
import { normalizeCandidate } from "./contract.js";
import { TorrentSearchError } from "./processing.js";
import { effectiveCustomProviders, readCustomProviders } from "../settings/torrent-providers.js";
import { customTorznabAdapter } from "./torznab.js";
import {
  jackettIsConfigured,
  NATIVE_PROVIDERS,
  providerIds,
  selectedNativeProviderIds,
} from "./native/registry.js";

// The configured adapter is selected here, never by search or playback consumers.
const providersById = [...NATIVE_PROVIDERS, { id: "jackett", name: "Jackett", search: searchJackett }];
export function configuredProviders(environment = process.env) {
  const savedCustom = readCustomProviders(environment);
  const custom = effectiveCustomProviders(environment, savedCustom).map(customTorznabAdapter);
  const explicit = environment.TORPLAY_SEARCH_PROVIDERS;
  const ids = explicit !== undefined
    ? providerIds(explicit)
    : [...selectedNativeProviderIds(environment), ...(jackettIsConfigured(environment) ? ["jackett"] : []), ...custom.map((item) => item.id)];
  return ids.filter((id) => !savedCustom.some((item) => item.id === id && !item.enabled)).map((id) => {
    const provider = [...providersById, ...custom].find((item) => item.id === id);
    if (!provider) throw new TorrentSearchError("Unknown torrent search provider ID.", 503);
    return provider;
  });
}

async function execute(provider, context, timeoutMs) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
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
  } finally {
    clearTimeout(timer);
  }
}

export async function searchConfiguredProvider(mediaContext, {
  providers = configuredProviders(),
  timeoutMs = 120_000,
  onFailure = (failure) => console.warn("[torrent-search]", failure.providerId, failure.category),
} = {}) {
  if (!providers.length) throw new TorrentSearchError("No torrent search providers are configured.", 503);
  const ids = new Set();
  for (const provider of providers) {
    if (!provider || !/^[a-z0-9][a-z0-9._-]*$/i.test(provider.id || "")
      || !provider.name || typeof provider.search !== "function" || ids.has(provider.id)) {
      throw new TorrentSearchError("Invalid torrent search provider configuration.", 503);
    }
    ids.add(provider.id);
  }
  const settled = await Promise.allSettled(providers.map((provider) => execute(provider, mediaContext, timeoutMs)));
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
