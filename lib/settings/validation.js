import { settingsProvider } from "./definitions.js";
import { validateFlareSolverrEndpoint } from "../search/cardigann/flaresolverr.js";
import { listJackettIndexers } from "../search/jackett-service.js";

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

async function validateFlareSolverr(environment, fetchImpl) {
  if (!configured(environment.FLARESOLVERR_URL)) return result("flaresolverr", "unconfigured", "Optional service is not configured.");
  let url;
  try { url = await validateFlareSolverrEndpoint(environment.FLARESOLVERR_URL); }
  catch { return result("flaresolverr", "invalid", "Use a FlareSolverr URL on this computer or a private LAN address."); }
  const response = await safeFetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cmd: "sessions.list" }), redirect: "error",
  }, fetchImpl);
  const failure = httpResult("flaresolverr", response);
  if (failure) return failure;
  const data = await response.json().catch(() => null);
  return data?.status === "ok" && Array.isArray(data.sessions)
    ? result("flaresolverr", "valid", "Connection verified.")
    : result("flaresolverr", "invalid", "FlareSolverr returned an unexpected response.");
}

async function validateJackett(environment, fetchImpl) {
  if (!configured(environment.JACKETT_URL) || !configured(environment.JACKETT_API_KEY)) {
    return result("jackett", "unconfigured", "Optional service URL and API key are not configured.");
  }
  try {
    await listJackettIndexers({ environment, fetchImpl });
    return result("jackett", "valid", "Connection verified.");
  } catch (error) {
    return [401, 403].includes(error.status)
      ? result("jackett", "invalid", "The configured Jackett API key was rejected.")
      : result("jackett", "unreachable", "Jackett could not be verified. Check its URL, API key, and service status.");
  }
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
  flaresolverr: validateFlareSolverr,
  omdb: validateOmdb,
  opensubtitles: validateOpenSubtitles,
  subdl: validateSubdl,
};

export function clearSettingsValidation(providerId) {
  if (providerId) validationCache.delete(providerId);
  else validationCache.clear();
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
      let value;
      try {
        value = await validators[id](environment, fetchImpl);
      } catch {
        value = result(id, "unreachable", "The service could not be reached.");
      }
      if (useCache) validationCache.set(id, { value, expiresAt: now + VALIDATION_CACHE_MS });
      output[index] = value;
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, ids.length) }, worker));
  return output;
}
