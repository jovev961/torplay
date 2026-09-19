import { settingsProvider } from "./definitions.js";

const VALIDATION_TIMEOUT_MS = 10_000;
const VALIDATION_CACHE_MS = 60_000;
const validationCache = new Map();

function configured(value) {
  const normalized = String(value || "").trim();
  return normalized && normalized !== "replace-me" ? normalized : "";
}

function result(provider, status, message, checkedAt = new Date().toISOString()) {
  return { provider, status, message, checkedAt };
}

async function safeFetch(url, options, fetchImpl) {
  try {
    return await fetchImpl(url, {
      ...options,
      cache: "no-store",
      signal: AbortSignal.timeout(VALIDATION_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
}

function httpResult(provider, response) {
  if (!response) return result(provider, "unreachable", "The service could not be reached.");
  if ([401, 403].includes(response.status)) return result(provider, "invalid", "The configured credential was rejected.");
  if (response.status === 429) return result(provider, "unreachable", "The provider rate limit prevented validation.");
  if (response.status >= 500) return result(provider, "unreachable", "The provider is temporarily unavailable.");
  if (!response.ok) return result(provider, "invalid", "The provider rejected the configured values.");
  return null;
}

async function validateTmdb(environment, fetchImpl) {
  const token = configured(environment.TMDB_API_TOKEN);
  if (!token) return result("tmdb", "missing", "Required API Read Access Token is not configured.");
  const response = await safeFetch("https://api.themoviedb.org/3/configuration", {
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
  }, fetchImpl);
  return httpResult("tmdb", response) || result("tmdb", "valid", "Connection verified.");
}

async function validateJackett(environment, fetchImpl) {
  const apiKey = configured(environment.JACKETT_API_KEY);
  const rawUrl = configured(environment.JACKETT_URL) || "http://localhost:9117";
  if (!apiKey) return result("jackett", "missing", "Required Jackett API key is not configured.");
  let url;
  try {
    url = new URL("api/v2.0/indexers/all/results/torznab/api", `${rawUrl.replace(/\/+$/, "")}/`);
  } catch {
    return result("jackett", "invalid", "The configured Jackett URL is invalid.");
  }
  url.searchParams.set("apikey", apiKey);
  url.searchParams.set("t", "caps");
  const response = await safeFetch(url, { headers: { Accept: "application/xml, text/xml" } }, fetchImpl);
  const failure = httpResult("jackett", response);
  if (failure) return failure;
  const body = await response.text().catch(() => "");
  return /<caps[\s>]/i.test(body)
    ? result("jackett", "valid", "Connection verified.")
    : result("jackett", "invalid", "Jackett returned an unexpected capabilities response.");
}

async function validateOmdb(environment, fetchImpl) {
  const apiKey = configured(environment.OMDB_API_KEY);
  if (!apiKey) return result("omdb", "unconfigured", "Optional service is not configured.");
  const url = new URL("https://www.omdbapi.com/");
  url.searchParams.set("apikey", apiKey);
  url.searchParams.set("i", "tt0111161");
  const response = await safeFetch(url, { headers: { Accept: "application/json" } }, fetchImpl);
  const failure = httpResult("omdb", response);
  if (failure) return failure;
  const data = await response.json().catch(() => null);
  if (data?.Response === "True") return result("omdb", "valid", "Connection verified.");
  return /invalid api key/i.test(String(data?.Error || ""))
    ? result("omdb", "invalid", "The configured credential was rejected.")
    : result("omdb", "unreachable", "OMDb returned an unexpected response.");
}

async function validateOpenSubtitles(environment, fetchImpl) {
  const apiKey = configured(environment.OPENSUBTITLES_API_KEY);
  if (!apiKey) return result("opensubtitles", "unconfigured", "Optional service is not configured.");
  const url = new URL("https://api.opensubtitles.com/api/v1/subtitles");
  url.searchParams.set("tmdb_id", "278");
  url.searchParams.set("languages", "en");
  const response = await safeFetch(url, {
    headers: {
      Accept: "application/json",
      "Api-Key": apiKey,
      "User-Agent": configured(environment.OPENSUBTITLES_USER_AGENT) || "TorPlay v0.1",
    },
  }, fetchImpl);
  return httpResult("opensubtitles", response) || result("opensubtitles", "valid", "Connection verified.");
}

async function validateSubdl(environment, fetchImpl) {
  const apiKey = configured(environment.SUBDL_API_KEY);
  if (!apiKey) return result("subdl", "unconfigured", "Optional service is not configured.");
  const url = new URL("https://api.subdl.com/api/v2/subtitles/search");
  url.searchParams.set("tmdb_id", "278");
  url.searchParams.set("type", "movie");
  url.searchParams.set("languages", "en");
  const response = await safeFetch(url, {
    headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
  }, fetchImpl);
  const failure = httpResult("subdl", response);
  if (failure) return failure;
  const data = await response.json().catch(() => null);
  return data && data.status !== false
    ? result("subdl", "valid", "Connection verified.")
    : result("subdl", "invalid", "The configured credential was rejected.");
}

const validators = {
  tmdb: validateTmdb,
  jackett: validateJackett,
  omdb: validateOmdb,
  opensubtitles: validateOpenSubtitles,
  subdl: validateSubdl,
};

export function clearSettingsValidation(providerId) {
  validationCache.delete(providerId);
}

export async function validateSettingsProviders(providerIds, {
  environment = process.env,
  fetchImpl = globalThis.fetch,
  now = Date.now(),
  useCache = true,
} = {}) {
  if (providerIds !== undefined && !Array.isArray(providerIds)) {
    throw Object.assign(new Error("Validation providers must be an array."), { status: 400 });
  }
  const ids = providerIds === undefined
    ? Object.keys(validators)
    : [...new Set(providerIds)];
  if (ids.some((id) => typeof id !== "string" || !settingsProvider(id))) {
    throw Object.assign(new Error("Validation contains an unknown provider."), { status: 400 });
  }
  const output = new Array(ids.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < ids.length) {
      const index = nextIndex;
      nextIndex += 1;
      const id = ids[index];
      const cached = validationCache.get(id);
      if (useCache && cached?.expiresAt > now) {
        output[index] = cached.value;
        continue;
      }
      const value = await validators[id](environment, fetchImpl);
      validationCache.set(id, { value, expiresAt: now + VALIDATION_CACHE_MS });
      output[index] = value;
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, ids.length) }, worker));
  return output;
}
