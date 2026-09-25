import { getSeasonDetails, getShowDetails } from "../metadata/tmdb.js";
import {
  findPlaybackSessionEpisode,
  getPlaybackMediaContext,
  updatePlaybackMediaContext,
} from "../debrid/session.js";

function episodeNumber(value, label, minimum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw Object.assign(new Error(`${label} is invalid.`), { status: 400 });
  }
  return parsed;
}

export function commitNextEpisodeContext(sessionId, input, dependencies = {}) {
  const getMediaContext = dependencies.getMediaContext || getPlaybackMediaContext;
  const mediaContext = getMediaContext(sessionId);
  if (!mediaContext || mediaContext.type !== "show" || !mediaContext.tmdbId) {
    throw Object.assign(new Error("The torrent session has no TV episode context."), { status: 400 });
  }
  const nextContext = {
    ...mediaContext,
    season: episodeNumber(input?.season, "Season number", 0),
    episode: episodeNumber(input?.episode, "Episode number", 1),
  };
  const updated = (dependencies.updateMediaContext || updatePlaybackMediaContext)(sessionId, nextContext);
  if (!updated) throw Object.assign(new Error("The torrent session has expired."), { status: 404 });
  return nextContext;
}

export async function findNextEpisode(showId, seasonNumber, episodeNumber) {
  const currentSeason = await getSeasonDetails(showId, seasonNumber);
  const currentIndex = currentSeason.episodes.findIndex((episode) => episode.number === episodeNumber);
  if (currentIndex < 0) return null;
  const sameSeason = currentSeason.episodes[currentIndex + 1];
  if (sameSeason) return { ...sameSeason, season: currentSeason.number };

  const show = await getShowDetails(showId);
  const laterSeasons = show.seasons
    .filter((season) => season.number > seasonNumber)
    .sort((left, right) => left.number - right.number);
  for (const season of laterSeasons) {
    const details = await getSeasonDetails(showId, season.number);
    if (details.episodes[0]) return { ...details.episodes[0], season: details.number };
  }
  return null;
}

export async function findPreviousEpisode(showId, seasonNumber, episodeNumber) {
  const currentSeason = await getSeasonDetails(showId, seasonNumber);
  const currentIndex = currentSeason.episodes.findIndex((episode) => episode.number === episodeNumber);
  if (currentIndex < 0) return null;
  const sameSeason = currentSeason.episodes[currentIndex - 1];
  if (sameSeason) return { ...sameSeason, season: currentSeason.number };

  const show = await getShowDetails(showId);
  const earlierSeasons = show.seasons
    .filter((season) => season.number < seasonNumber && (seasonNumber === 0 || season.number > 0))
    .sort((left, right) => right.number - left.number);
  for (const season of earlierSeasons) {
    const details = await getSeasonDetails(showId, season.number);
    const lastEpisode = details.episodes.at(-1);
    if (lastEpisode) return { ...lastEpisode, season: details.number };
  }
  return null;
}

async function findSelectedEpisode(showId, target) {
  const season = episodeNumber(target?.season, "Season number", 0);
  const number = episodeNumber(target?.episode, "Episode number", 1);
  const details = await getSeasonDetails(showId, season);
  const selected = details.episodes.find((episode) => episode.number === number);
  return selected ? { ...selected, season: details.number } : null;
}

export async function resolveNextEpisodePlayback(sessionId, dependencies = {}, direction = "next", target = null) {
  if (!["next", "previous", "selected"].includes(direction)) {
    throw Object.assign(new Error("Episode direction is invalid."), { status: 400 });
  }
  const mediaContext = (dependencies.getMediaContext || getPlaybackMediaContext)(sessionId);
  if (!mediaContext || mediaContext.type !== "show" || !mediaContext.tmdbId) {
    throw Object.assign(new Error("The torrent session has no TV episode context."), { status: 400 });
  }
  const nextEpisode = direction === "selected"
    ? await (dependencies.selectedEpisode || findSelectedEpisode)(mediaContext.tmdbId, target)
    : await (direction === "previous"
      ? dependencies.previousEpisode || findPreviousEpisode
      : dependencies.nextEpisode || findNextEpisode)(
      mediaContext.tmdbId,
      mediaContext.season,
      mediaContext.episode,
    );
  if (!nextEpisode) return { status: "end-of-series", nextEpisode: null };

  const reuse = (dependencies.findSessionEpisode || findPlaybackSessionEpisode)(
    sessionId,
    nextEpisode.season,
    nextEpisode.number,
  );
  if (reuse) {
    return { status: "ready", strategy: "reuse", nextEpisode, session: reuse.session, fileId: reuse.file.id };
  }

  return { status: "manual-required", strategy: "search", nextEpisode,
    error: "The selected torrent does not contain the next episode." };
}
