import { getSeasonDetails, getShowDetails } from "../metadata/tmdb.js";
import { startBestVerifiedSource } from "../search/service.js";
import { resolveDirectDebridPlayback } from "../debrid/library.js";
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

export async function resolveNextEpisodePlayback(sessionId, dependencies = {}) {
  const mediaContext = (dependencies.getMediaContext || getPlaybackMediaContext)(sessionId);
  if (!mediaContext || mediaContext.type !== "show" || !mediaContext.tmdbId) {
    throw Object.assign(new Error("The torrent session has no TV episode context."), { status: 400 });
  }
  const nextEpisode = await (dependencies.nextEpisode || findNextEpisode)(
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

  const nextContext = {
    ...mediaContext,
    season: nextEpisode.season,
    episode: nextEpisode.number,
  };
  try {
    const direct = await (dependencies.resolveDirectDebrid || resolveDirectDebridPlayback)(nextContext);
    if (direct.kind === "hit") {
      return { status: "ready", strategy: "debrid", nextEpisode,
        session: direct.session, fileId: direct.fileId };
    }
    const started = await (dependencies.startBestSource || startBestVerifiedSource)(nextContext);
    if (!started) return { status: "manual-required", strategy: "search", nextEpisode };
    if (started.session.kind) return { status: "manual-required", strategy: "search", nextEpisode };
    return {
      status: started.session.status === "ready" ? "ready" : "preparing",
      strategy: "new-torrent",
      nextEpisode,
      session: started.session,
      fileId: null,
    };
  } catch (error) {
    return {
      status: "manual-required",
      strategy: "search",
      nextEpisode,
      error: error.message || "No playable source was found.",
    };
  }
}
