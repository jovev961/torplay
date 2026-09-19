const OMDB_API_URL = "https://www.omdbapi.com/";
const OMDB_TIMEOUT_MS = 8_000;

export class OmdbError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "OmdbError";
    this.status = status;
  }
}

export function isOmdbConfigured(environment = process.env) {
  const value = environment.OMDB_API_KEY?.trim();
  return Boolean(value && value !== "replace-me");
}

function apiKey(environment) {
  if (!isOmdbConfigured(environment)) {
    throw new OmdbError("OMDb is not configured. Add OMDB_API_KEY to .env.local.", 500);
  }
  return environment.OMDB_API_KEY.trim();
}

export async function getOmdbRating(imdbId, {
  environment = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof imdbId !== "string" || !/^tt\d+$/.test(imdbId)) {
    throw new OmdbError("A valid IMDb ID is required.", 400);
  }

  const url = new URL(OMDB_API_URL);
  url.searchParams.set("apikey", apiKey(environment));
  url.searchParams.set("i", imdbId);
  url.searchParams.set("plot", "short");

  let response;
  try {
    response = await fetchImpl(url, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(OMDB_TIMEOUT_MS),
    });
  } catch (error) {
    if (error?.name === "TimeoutError") {
      throw new OmdbError("OMDb did not respond before the request timed out.", 504);
    }
    throw new OmdbError("Could not reach OMDb.", 502);
  }

  if (!response.ok) throw new OmdbError(`OMDb returned HTTP ${response.status}.`, 502);
  const data = await response.json();
  if (data?.Response === "False" || data?.imdbRating === "N/A") return null;
  const rating = Number(data?.imdbRating);
  if (!Number.isFinite(rating) || rating < 0 || rating > 10) {
    throw new OmdbError("OMDb returned an invalid rating response.", 502);
  }
  return rating;
}
