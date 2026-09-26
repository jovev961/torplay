import { interleaveByRank } from "./catalog.js";
import { readPersistentCache, writePersistentCache } from "../cache/persistent.js";
import { normalizeLocale, tmdbLocale } from "../i18n/locales.js";
import { translate } from "../i18n/index.js";

const TMDB_API_URL = "https://api.themoviedb.org/3/";
const TMDB_IMAGE_URL = "https://image.tmdb.org/t/p/";
const TMDB_TIMEOUT_MS = 10_000;
const MAX_PAGE = 500;
const defaultFetch = globalThis.fetch;

export const TMDB_SEARCH_CACHE_TTL_MS = 5 * 60 * 1_000;
export const TMDB_METADATA_CACHE_TTL_MS = 60 * 60 * 1_000;

export class TmdbError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "TmdbError";
    this.status = status;
  }
}

function token() {
  const value = process.env.TMDB_API_TOKEN?.trim();
  if (!value) {
    throw new TmdbError("TMDB is not configured. Complete TorPlay setup or update Settings on this computer.", 500);
  }
  if (/^[a-f\d]{32}$/i.test(value)) {
    throw new TmdbError(
      "TMDB_API_TOKEN must be the API Read Access Token, not the 32-character v3 API key.",
      500,
    );
  }
  return value;
}

function positiveInteger(value, label, { allowZero = false } = {}) {
  const parsed = Number(value);
  const minimum = allowZero ? 0 : 1;
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new TmdbError(`${label} must be a valid integer.`, 400);
  }
  return parsed;
}

async function tmdbRequest(path, {
  params = {},
  locale = "en",
  cache = true,
  revalidate = 3600,
  persistentTtlMs = cache ? revalidate * 1_000 : 0,
  fetchImpl = globalThis.fetch,
  usePersistentCache = fetchImpl === defaultFetch,
  cacheDatabase,
  now = Date.now(),
} = {}) {
  const url = new URL(path.replace(/^\/+/, ""), TMDB_API_URL);
  url.searchParams.set("language", tmdbLocale(locale));
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(name, String(value));
    }
  }
  const authorization = token();
  const cacheKey = `${url.pathname}${url.search}`;
  if (usePersistentCache && persistentTtlMs > 0) {
    const cached = readPersistentCache("tmdb", cacheKey, { database: cacheDatabase, now });
    if (cached.hit) return cached.value;
  }

  let response;
  try {
    response = await fetchImpl(url, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${authorization}`,
      },
      ...(cache ? { next: { revalidate } } : { cache: "no-store" }),
      signal: AbortSignal.timeout(TMDB_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof TmdbError) throw error;
    if (error?.name === "TimeoutError") {
      throw new TmdbError("TMDB did not respond before the request timed out.", 504);
    }
    throw new TmdbError("Could not reach TMDB. Check your network connection.", 502);
  }

  if (response.status === 404) throw new TmdbError("The requested title was not found.", 404);
  if (!response.ok) {
    const detail = response.status === 401 || response.status === 403
      ? " Check TMDB_API_TOKEN."
      : "";
    throw new TmdbError(`TMDB returned HTTP ${response.status}.${detail}`, 502);
  }
  const data = await response.json();
  if (usePersistentCache && persistentTtlMs > 0) {
    writePersistentCache("tmdb", cacheKey, data, {
      database: cacheDatabase,
      now,
      ttlMs: persistentTtlMs,
    });
  }
  return data;
}

async function localizedRequest(path, options = {}) {
  const locale = normalizeLocale(options.locale);
  const primary = await tmdbRequest(path, { ...options, locale });
  if (locale === "en") return { primary, fallback: null };
  const fallback = await tmdbRequest(path, { ...options, locale: "en" });
  return { primary, fallback };
}

export function tmdbImage(path, size) {
  if (typeof path !== "string" || !/^\/[a-z\d._/-]+$/i.test(path)) return null;
  return `${TMDB_IMAGE_URL}${size}${path}`;
}

function year(value) {
  return typeof value === "string" && /^\d{4}/.test(value) ? value.slice(0, 4) : null;
}

function normalizeMediaType(value, { allowAll = false } = {}) {
  if (value === "show") return "tv";
  if (value === "movie" || value === "tv" || (allowAll && (value === "all" || !value))) {
    return value || "all";
  }
  throw new TmdbError(allowAll ? "Type must be all, movie, or tv." : "Invalid media type.", 400);
}

function normalizePage(value) {
  const parsed = value === undefined || value === null || value === "" ? 1 : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_PAGE) {
    throw new TmdbError(`Page must be an integer between 1 and ${MAX_PAGE}.`, 400);
  }
  return parsed;
}

function fallbackItemFor(item, fallbackData) {
  if (!item || !fallbackData) return null;
  if (Array.isArray(fallbackData.results)) {
    return fallbackData.results.find((candidate) => candidate.id === item.id) || null;
  }
  return fallbackData.id === item.id ? fallbackData : fallbackData;
}

function localizedValue(value, fallback) {
  return typeof value === "string" && value.trim() ? value : (typeof fallback === "string" ? fallback : "");
}

function normalizeSummary(item, mediaType, fallbackItem = null) {
  const genreIds = Array.isArray(item.genre_ids)
    ? item.genre_ids.filter(Number.isInteger)
    : Array.isArray(item.genres) ? item.genres.map((genre) => genre.id).filter(Number.isInteger) : [];
  return {
    id: item.id,
    mediaType,
    title: localizedValue(mediaType === "movie" ? item.title : item.name,
      fallbackItem && (mediaType === "movie" ? fallbackItem.title : fallbackItem.name)),
    sourceTitle: localizedValue(fallbackItem && (mediaType === "movie" ? fallbackItem.title : fallbackItem.name),
      mediaType === "movie" ? item.title : item.name),
    originalTitle: mediaType === "movie"
      ? item.original_title || fallbackItem?.original_title || item.title
      : item.original_name || fallbackItem?.original_name || item.name,
    overview: localizedValue(item.overview, fallbackItem?.overview),
    year: year(mediaType === "movie" ? item.release_date : item.first_air_date),
    posterUrl: tmdbImage(item.poster_path, "w500"),
    backdropUrl: tmdbImage(item.backdrop_path, "w1280"),
    genreIds,
    rating: Number.isFinite(item.vote_average) ? item.vote_average : null,
    popularity: Number.isFinite(item.popularity) ? item.popularity : null,
  };
}

function normalizeList(data, mediaType, fallbackData = null) {
  return Array.isArray(data?.results)
    ? data.results.filter((item) => Number.isInteger(item.id))
      .map((item) => normalizeSummary(item, mediaType, fallbackItemFor(item, fallbackData)))
    : [];
}

function slugifyGenre(name) {
  return name.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function normalizeGenreList(data) {
  return Array.isArray(data?.genres)
    ? data.genres.filter((genre) => Number.isInteger(genre.id) && typeof genre.name === "string")
    : [];
}

function combineGenres(movieGenres, tvGenres, localizedMovieGenres = movieGenres, localizedTvGenres = tvGenres) {
  const localizedByType = {
    movie: new Map(localizedMovieGenres.map((genre) => [genre.id, genre.name])),
    tv: new Map(localizedTvGenres.map((genre) => [genre.id, genre.name])),
  };
  const genres = new Map();
  for (const [mediaType, list] of [["movie", movieGenres], ["tv", tvGenres]]) {
    for (const genre of list) {
      const slug = slugifyGenre(genre.name);
      const current = genres.get(slug) || {
        slug,
        name: localizedByType[mediaType].get(genre.id) || genre.name,
        movieGenreId: null,
        tvGenreId: null,
      };
      current[mediaType === "movie" ? "movieGenreId" : "tvGenreId"] = genre.id;
      genres.set(slug, current);
    }
  }
  return [...genres.values()]
    .map((genre) => ({
      ...genre,
      supportedMediaTypes: [
        ...(genre.movieGenreId ? ["movie"] : []),
        ...(genre.tvGenreId ? ["tv"] : []),
      ],
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function pagination(data) {
  return {
    page: Number.isInteger(data?.page) ? data.page : 1,
    totalPages: Number.isInteger(data?.total_pages) ? data.total_pages : 0,
    totalResults: Number.isInteger(data?.total_results) ? data.total_results : 0,
  };
}

function emptyPage(page) {
  return { results: [], page, totalPages: 0, totalResults: 0 };
}

function combinePages(pages, page, totalsExact) {
  const results = interleaveByRank(...pages.map((item) => item.results));
  const totalPages = Math.max(0, ...pages.map((item) => item.totalPages));
  const totalResults = pages.reduce((sum, item) => sum + item.totalResults, 0);
  return {
    results,
    page,
    totalPages,
    totalResults,
    hasPreviousPage: page > 1,
    hasNextPage: page < totalPages,
    totalsExact,
  };
}

async function resolveGenre(slug, locale) {
  if (!slug) return null;
  const genres = await getGenreDefinitions("all", { locale });
  const genre = genres.find((item) => item.slug === slug);
  if (!genre) throw new TmdbError("Unknown genre.", 400);
  return genre;
}

async function searchType(mediaType, query, page, genre, locale) {
  const genreId = genre?.[mediaType === "movie" ? "movieGenreId" : "tvGenreId"];
  if (genre && !genreId) return emptyPage(page);
  const { primary, fallback } = await localizedRequest(`search/${mediaType}`, {
    locale,
    params: { query, include_adult: false, page },
    cache: false,
    persistentTtlMs: TMDB_SEARCH_CACHE_TTL_MS,
  });
  const pageData = pagination(primary);
  const results = normalizeList(primary, mediaType, fallback);
  return {
    ...pageData,
    results: genre ? results.filter((item) => item.genreIds.includes(genreId)) : results,
  };
}

async function discoverType(mediaType, page, genre, locale) {
  const genreId = genre?.[mediaType === "movie" ? "movieGenreId" : "tvGenreId"];
  if (genre && !genreId) return emptyPage(page);
  const { primary, fallback } = await localizedRequest(`discover/${mediaType}`, {
    locale,
    params: {
      include_adult: false,
      page,
      sort_by: "popularity.desc",
      with_genres: genreId,
    },
    revalidate: 900,
  });
  return { ...pagination(primary), results: normalizeList(primary, mediaType, fallback) };
}

export async function getTrending(type, { locale = "en" } = {}) {
  const mediaType = normalizeMediaType(type);
  const { primary, fallback } = await localizedRequest(`trending/${mediaType}/week`, { locale });
  return normalizeList(primary, mediaType, fallback);
}

export async function searchMetadata(type, input, { locale = "en" } = {}) {
  const result = await searchCatalog({ type: normalizeMediaType(type), query: input, page: 1, locale });
  return result.results;
}

export async function getGenreDefinitions(type = "all", requestOptions = {}) {
  const locale = requestOptions.locale || "en";
  const filter = normalizeMediaType(type, { allowAll: true });
  const [movieData, tvData] = await Promise.all([
    filter === "tv" ? Promise.resolve({ primary: [], fallback: [] })
      : localizedRequest("genre/movie/list", { ...requestOptions, revalidate: 86400, locale })
        .then(({ primary, fallback }) => ({ primary: normalizeGenreList(primary), fallback: normalizeGenreList(fallback || primary) })),
    filter === "movie" ? Promise.resolve({ primary: [], fallback: [] })
      : localizedRequest("genre/tv/list", { ...requestOptions, revalidate: 86400, locale })
        .then(({ primary, fallback }) => ({ primary: normalizeGenreList(primary), fallback: normalizeGenreList(fallback || primary) })),
  ]);
  return combineGenres(movieData.fallback, tvData.fallback, movieData.primary, tvData.primary);
}

export async function searchCatalog({ query: input, type = "all", genre: genreSlug = "", page: pageInput = 1, locale = "en" } = {}) {
  const mediaFilter = normalizeMediaType(type, { allowAll: true });
  const page = normalizePage(pageInput);
  const query = typeof input === "string" ? input.trim() : "";
  if (query.length > 200) throw new TmdbError("Search terms must be 200 characters or fewer.", 400);
  if (!query) return combinePages([emptyPage(page)], page, true);
  const genre = await resolveGenre(typeof genreSlug === "string" ? genreSlug.trim() : "", locale);
  const mediaTypes = mediaFilter === "all" ? ["movie", "tv"] : [mediaFilter];
  const pages = await Promise.all(mediaTypes.map((mediaType) => searchType(mediaType, query, page, genre, locale)));
  return combinePages(pages, page, !genre);
}

export async function discoverCatalog({ type = "all", genre: genreSlug = "", page: pageInput = 1, locale = "en" } = {}) {
  const mediaFilter = normalizeMediaType(type, { allowAll: true });
  const page = normalizePage(pageInput);
  const genre = await resolveGenre(typeof genreSlug === "string" ? genreSlug.trim() : "", locale);
  const mediaTypes = mediaFilter === "all" ? ["movie", "tv"] : [mediaFilter];
  const pages = await Promise.all(mediaTypes.map((mediaType) => discoverType(mediaType, page, genre, locale)));
  return combinePages(pages, page, true);
}

export async function getTitleRecommendations(type, id, requestOptions = {}) {
  const mediaType = normalizeMediaType(type);
  const tmdbId = positiveInteger(id, "TMDB ID");
  const { primary, fallback } = await localizedRequest(`${mediaType}/${tmdbId}/recommendations`, {
    ...requestOptions,
    params: { page: 1, include_adult: false },
    cache: false,
    persistentTtlMs: 0,
    usePersistentCache: false,
  });
  return normalizeList(primary, mediaType, fallback)
    .filter((item) => typeof item.title === "string" && item.title.trim());
}

export async function getMovieDetails(id, requestOptions = {}) {
  const movieId = positiveInteger(id, "Movie ID");
  const { primary: item, fallback } = await localizedRequest(`movie/${movieId}`, requestOptions);
  return {
    ...normalizeSummary(item, "movie", fallback),
    runtime: Number.isInteger(item.runtime) ? item.runtime : null,
    genres: Array.isArray(item.genres) ? item.genres.map((genre) => genre.name).filter(Boolean)
      : Array.isArray(fallback?.genres) ? fallback.genres.map((genre) => genre.name).filter(Boolean) : [],
    imdbId: item.imdb_id || null,
  };
}

export async function getShowDetails(id, requestOptions = {}) {
  const showId = positiveInteger(id, "Show ID");
  const { primary: item, fallback } = await localizedRequest(`tv/${showId}`, {
    ...requestOptions,
    params: { ...requestOptions.params, append_to_response: "external_ids" },
  });
  const fallbackSeasons = new Map((fallback?.seasons || []).map((season) => [season.season_number, season]));
  return {
    ...normalizeSummary(item, "tv", fallback),
    status: item.status || null,
    imdbId: item.external_ids?.imdb_id || null,
    genres: Array.isArray(item.genres) ? item.genres.map((genre) => genre.name).filter(Boolean)
      : Array.isArray(fallback?.genres) ? fallback.genres.map((genre) => genre.name).filter(Boolean) : [],
    seasons: Array.isArray(item.seasons)
      ? item.seasons
          .filter((season) => Number.isInteger(season.season_number) && season.episode_count > 0)
          .map((season) => ({
            number: season.season_number,
            name: localizedValue(season.name, fallbackSeasons.get(season.season_number)?.name)
              || translate(requestOptions.locale, season.season_number === 0
                ? "Specials" : `Season ${season.season_number}`),
            episodeCount: season.episode_count,
            posterUrl: tmdbImage(season.poster_path, "w500"),
          }))
      : [],
  };
}

export async function getImdbId(type, id) {
  const mediaType = normalizeMediaType(type);
  const tmdbId = positiveInteger(id, "TMDB ID");
  const item = await tmdbRequest(`${mediaType}/${tmdbId}/external_ids`, { revalidate: 2592000 });
  return typeof item.imdb_id === "string" && /^tt\d+$/.test(item.imdb_id)
    ? item.imdb_id
    : null;
}

export async function getSeasonDetails(showId, seasonNumber, requestOptions = {}) {
  const id = positiveInteger(showId, "Show ID");
  const season = positiveInteger(seasonNumber, "Season number", { allowZero: true });
  const { primary: item, fallback } = await localizedRequest(`tv/${id}/season/${season}`, requestOptions);
  const fallbackEpisodes = new Map((fallback?.episodes || []).map((episode) => [episode.episode_number, episode]));
  return {
    number: item.season_number,
    name: localizedValue(item.name, fallback?.name)
      || translate(requestOptions.locale, season === 0 ? "Specials" : `Season ${season}`),
    overview: localizedValue(item.overview, fallback?.overview),
    episodes: Array.isArray(item.episodes)
      ? item.episodes.map((episode) => ({
        number: episode.episode_number,
        title: localizedValue(episode.name, fallbackEpisodes.get(episode.episode_number)?.name)
          || translate(requestOptions.locale, `Episode ${episode.episode_number}`),
        overview: localizedValue(episode.overview, fallbackEpisodes.get(episode.episode_number)?.overview),
        airDate: episode.air_date || null,
        stillUrl: tmdbImage(episode.still_path, "w500"),
      }))
      : [],
  };
}
