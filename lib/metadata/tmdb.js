import { interleaveByRank } from "./catalog.js";

const TMDB_API_URL = "https://api.themoviedb.org/3/";
const TMDB_IMAGE_URL = "https://image.tmdb.org/t/p/";
const TMDB_TIMEOUT_MS = 10_000;
const MAX_PAGE = 500;

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
    throw new TmdbError("TMDB is not configured. Add TMDB_API_TOKEN to .env.local.", 500);
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

async function tmdbRequest(path, { params = {}, cache = true, revalidate = 3600 } = {}) {
  const url = new URL(path.replace(/^\/+/, ""), TMDB_API_URL);
  url.searchParams.set("language", "en-US");
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(name, String(value));
    }
  }

  let response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token()}`,
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
  return response.json();
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

function normalizeSummary(item, mediaType) {
  const genreIds = Array.isArray(item.genre_ids)
    ? item.genre_ids.filter(Number.isInteger)
    : Array.isArray(item.genres) ? item.genres.map((genre) => genre.id).filter(Number.isInteger) : [];
  return {
    id: item.id,
    mediaType,
    title: mediaType === "movie" ? item.title : item.name,
    originalTitle: mediaType === "movie" ? item.original_title || item.title : item.original_name || item.name,
    overview: item.overview || "",
    year: year(mediaType === "movie" ? item.release_date : item.first_air_date),
    posterUrl: tmdbImage(item.poster_path, "w500"),
    backdropUrl: tmdbImage(item.backdrop_path, "w1280"),
    genreIds,
    rating: Number.isFinite(item.vote_average) ? item.vote_average : null,
    popularity: Number.isFinite(item.popularity) ? item.popularity : null,
  };
}

function normalizeList(data, mediaType) {
  return Array.isArray(data?.results)
    ? data.results.filter((item) => Number.isInteger(item.id)).map((item) => normalizeSummary(item, mediaType))
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

function combineGenres(movieGenres, tvGenres) {
  const genres = new Map();
  for (const [mediaType, list] of [["movie", movieGenres], ["tv", tvGenres]]) {
    for (const genre of list) {
      const slug = slugifyGenre(genre.name);
      const current = genres.get(slug) || {
        slug,
        name: genre.name,
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

async function resolveGenre(slug) {
  if (!slug) return null;
  const genres = await getGenreDefinitions("all");
  const genre = genres.find((item) => item.slug === slug);
  if (!genre) throw new TmdbError("Unknown genre.", 400);
  return genre;
}

async function searchType(mediaType, query, page, genre) {
  const genreId = genre?.[mediaType === "movie" ? "movieGenreId" : "tvGenreId"];
  if (genre && !genreId) return emptyPage(page);
  const data = await tmdbRequest(`search/${mediaType}`, {
    params: { query, include_adult: false, page },
    cache: false,
  });
  const pageData = pagination(data);
  const results = normalizeList(data, mediaType);
  return {
    ...pageData,
    results: genre ? results.filter((item) => item.genreIds.includes(genreId)) : results,
  };
}

async function discoverType(mediaType, page, genre) {
  const genreId = genre?.[mediaType === "movie" ? "movieGenreId" : "tvGenreId"];
  if (genre && !genreId) return emptyPage(page);
  const data = await tmdbRequest(`discover/${mediaType}`, {
    params: {
      include_adult: false,
      page,
      sort_by: "popularity.desc",
      with_genres: genreId,
    },
    revalidate: 900,
  });
  return { ...pagination(data), results: normalizeList(data, mediaType) };
}

export async function getTrending(type) {
  const mediaType = normalizeMediaType(type);
  return normalizeList(await tmdbRequest(`trending/${mediaType}/week`), mediaType);
}

export async function searchMetadata(type, input) {
  const result = await searchCatalog({ type: normalizeMediaType(type), query: input, page: 1 });
  return result.results;
}

export async function getGenreDefinitions(type = "all") {
  const filter = normalizeMediaType(type, { allowAll: true });
  const [movieGenres, tvGenres] = await Promise.all([
    filter === "tv" ? Promise.resolve([]) : tmdbRequest("genre/movie/list", { revalidate: 86400 }).then(normalizeGenreList),
    filter === "movie" ? Promise.resolve([]) : tmdbRequest("genre/tv/list", { revalidate: 86400 }).then(normalizeGenreList),
  ]);
  return combineGenres(movieGenres, tvGenres);
}

export async function searchCatalog({ query: input, type = "all", genre: genreSlug = "", page: pageInput = 1 } = {}) {
  const mediaFilter = normalizeMediaType(type, { allowAll: true });
  const page = normalizePage(pageInput);
  const query = typeof input === "string" ? input.trim() : "";
  if (query.length > 200) throw new TmdbError("Search terms must be 200 characters or fewer.", 400);
  if (!query) return combinePages([emptyPage(page)], page, true);
  const genre = await resolveGenre(typeof genreSlug === "string" ? genreSlug.trim() : "");
  const mediaTypes = mediaFilter === "all" ? ["movie", "tv"] : [mediaFilter];
  const pages = await Promise.all(mediaTypes.map((mediaType) => searchType(mediaType, query, page, genre)));
  return combinePages(pages, page, !genre);
}

export async function discoverCatalog({ type = "all", genre: genreSlug = "", page: pageInput = 1 } = {}) {
  const mediaFilter = normalizeMediaType(type, { allowAll: true });
  const page = normalizePage(pageInput);
  const genre = await resolveGenre(typeof genreSlug === "string" ? genreSlug.trim() : "");
  const mediaTypes = mediaFilter === "all" ? ["movie", "tv"] : [mediaFilter];
  const pages = await Promise.all(mediaTypes.map((mediaType) => discoverType(mediaType, page, genre)));
  return combinePages(pages, page, true);
}

export async function getMovieDetails(id) {
  const movieId = positiveInteger(id, "Movie ID");
  const item = await tmdbRequest(`movie/${movieId}`);
  return {
    ...normalizeSummary(item, "movie"),
    runtime: Number.isInteger(item.runtime) ? item.runtime : null,
    genres: Array.isArray(item.genres) ? item.genres.map((genre) => genre.name).filter(Boolean) : [],
    imdbId: item.imdb_id || null,
  };
}

export async function getShowDetails(id) {
  const showId = positiveInteger(id, "Show ID");
  const item = await tmdbRequest(`tv/${showId}`);
  return {
    ...normalizeSummary(item, "tv"),
    status: item.status || null,
    genres: Array.isArray(item.genres) ? item.genres.map((genre) => genre.name).filter(Boolean) : [],
    seasons: Array.isArray(item.seasons)
      ? item.seasons
          .filter((season) => Number.isInteger(season.season_number) && season.episode_count > 0)
          .map((season) => ({
            number: season.season_number,
            name: season.name || (season.season_number === 0 ? "Specials" : `Season ${season.season_number}`),
            episodeCount: season.episode_count,
            posterUrl: tmdbImage(season.poster_path, "w500"),
          }))
      : [],
  };
}

export async function getSeasonDetails(showId, seasonNumber) {
  const id = positiveInteger(showId, "Show ID");
  const season = positiveInteger(seasonNumber, "Season number", { allowZero: true });
  const item = await tmdbRequest(`tv/${id}/season/${season}`);
  return {
    number: item.season_number,
    name: item.name || (season === 0 ? "Specials" : `Season ${season}`),
    overview: item.overview || "",
    episodes: Array.isArray(item.episodes)
      ? item.episodes.map((episode) => ({
        number: episode.episode_number,
        title: episode.name || `Episode ${episode.episode_number}`,
        overview: episode.overview || "",
        airDate: episode.air_date || null,
        stillUrl: tmdbImage(episode.still_path, "w500"),
      }))
      : [],
  };
}
