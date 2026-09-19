import { randomUUID } from "node:crypto";
import { getDatabase } from "../database/sqlite.js";
import { findNextEpisode } from "../playback/next-episode.js";
import {
  COMPLETION_RATIO,
  COMPLETION_REMAINING_MIN_RATIO,
  COMPLETION_REMAINING_SECONDS,
  CONTINUE_WATCHING_MIN_SECONDS,
} from "./constants.js";

export {
  COMPLETION_RATIO,
  COMPLETION_REMAINING_MIN_RATIO,
  COMPLETION_REMAINING_SECONDS,
  CONTINUE_WATCHING_MIN_SECONDS,
  PROGRESS_SAVE_INTERVAL_MS,
} from "./constants.js";

export class HistoryError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "HistoryError";
    this.status = status;
  }
}

function integer(value, label, minimum = 1) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) throw new HistoryError(`${label} is invalid.`);
  return parsed;
}

function text(value, label, maximum, { optional = false } = {}) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized && !optional) throw new HistoryError(`${label} is required.`);
  if (normalized.length > maximum) throw new HistoryError(`${label} is too long.`);
  return normalized || null;
}

export function normalizeMediaIdentity(input = {}) {
  const mediaType = input.mediaType === "tv" ? "tv" : input.mediaType === "movie" ? "movie" : null;
  if (!mediaType) throw new HistoryError("Media type must be movie or tv.");
  const identity = {
    mediaType,
    tmdbId: integer(input.tmdbId, "TMDB ID"),
    seasonNumber: -1,
    episodeNumber: -1,
  };
  if (mediaType === "tv") {
    identity.seasonNumber = integer(input.seasonNumber, "Season number", 0);
    identity.episodeNumber = integer(input.episodeNumber, "Episode number");
  }
  return identity;
}

function normalizeMedia(input = {}) {
  return {
    ...normalizeMediaIdentity(input),
    title: text(input.title, "Title", 300),
    episodeTitle: text(input.episodeTitle, "Episode title", 300, { optional: true }),
    posterUrl: text(input.posterUrl, "Poster URL", 1000, { optional: true }),
    backdropUrl: text(input.backdropUrl, "Backdrop URL", 1000, { optional: true }),
  };
}

function identityValues(profileId, identity) {
  return [profileId, identity.mediaType, identity.tmdbId, identity.seasonNumber, identity.episodeNumber];
}

function publicEntry(row) {
  return row ? {
    profileId: row.profile_id,
    mediaType: row.media_type,
    tmdbId: row.tmdb_id,
    seasonNumber: row.season_number,
    episodeNumber: row.episode_number,
    title: row.title,
    episodeTitle: row.episode_title,
    posterUrl: row.poster_url,
    backdropUrl: row.backdrop_url,
    position: row.position_seconds,
    duration: row.duration_seconds,
    completed: Boolean(row.completed),
    lastWatchedAt: row.last_watched_at,
  } : null;
}

function groupedHistory(rows, { includeEpisodes = false } = {}) {
  const groups = new Map();
  for (const row of rows) {
    const entry = publicEntry(row);
    const key = `${entry.mediaType}:${entry.tmdbId}`;
    const group = groups.get(key);
    if (!group) {
      groups.set(key, entry.mediaType === "tv" && includeEpisodes
        ? { ...entry, episodes: [entry] }
        : entry);
    } else if (entry.mediaType === "tv" && includeEpisodes) {
      group.episodes.push(entry);
    }
  }
  return [...groups.values()];
}

function requireProfile(profileId, database) {
  if (!database.prepare("SELECT 1 FROM profiles WHERE id = ?").get(profileId)) {
    throw new HistoryError("Profile not found.", 404);
  }
}

export function getProgress(profileId, input, database = getDatabase()) {
  requireProfile(profileId, database);
  const identity = normalizeMediaIdentity(input);
  const row = database.prepare(`
    SELECT * FROM watch_history
    WHERE profile_id = ? AND media_type = ? AND tmdb_id = ?
      AND season_number = ? AND episode_number = ?
  `).get(...identityValues(profileId, identity));
  return publicEntry(row);
}

export function listHistory(profileId, database = getDatabase()) {
  requireProfile(profileId, database);
  const rows = database.prepare(`
    SELECT * FROM watch_history WHERE profile_id = ?
    ORDER BY last_watched_at DESC, season_number DESC, episode_number DESC
  `).all(profileId);
  return groupedHistory(rows, { includeEpisodes: true });
}

function episodeIdentity(entry) {
  return `${entry.tmdbId}:${entry.seasonNumber}:${entry.episodeNumber}`;
}

async function advanceCompletedShow(item, entries, resolveNextEpisode) {
  const visited = new Set();
  let current = item;

  while (current.completed) {
    const currentIdentity = episodeIdentity(current);
    if (visited.has(currentIdentity)) return null;
    visited.add(currentIdentity);

    const nextEpisode = await resolveNextEpisode(
      current.tmdbId,
      current.seasonNumber,
      current.episodeNumber,
    );
    if (!nextEpisode) return null;

    const saved = entries.get(`${current.tmdbId}:${nextEpisode.season}:${nextEpisode.number}`);
    if (saved) {
      current = saved;
      continue;
    }

    return {
      ...item,
      seasonNumber: nextEpisode.season,
      episodeNumber: nextEpisode.number,
      episodeTitle: nextEpisode.title || `Episode ${nextEpisode.number}`,
      backdropUrl: nextEpisode.stillUrl || item.backdropUrl,
      position: 0,
      duration: 0,
      completed: false,
    };
  }

  return current.position >= CONTINUE_WATCHING_MIN_SECONDS ? current : null;
}

export async function listContinueWatching(
  profileId,
  database = getDatabase(),
  dependencies = {},
) {
  requireProfile(profileId, database);
  const rows = database.prepare(`
    SELECT * FROM watch_history WHERE profile_id = ?
    ORDER BY last_watched_at DESC, season_number DESC, episode_number DESC
  `).all(profileId);
  const items = groupedHistory(rows);
  const entries = new Map(
    rows
      .filter((row) => row.media_type === "tv")
      .map((row) => {
        const entry = publicEntry(row);
        return [episodeIdentity(entry), entry];
      }),
  );
  const resolveNextEpisode = dependencies.findNextEpisode || findNextEpisode;
  const resolved = await Promise.all(items.map(async (item) => {
    if (!item.completed) {
      return item.position >= CONTINUE_WATCHING_MIN_SECONDS ? item : null;
    }
    if (item.mediaType !== "tv") return null;
    try {
      return await advanceCompletedShow(item, entries, resolveNextEpisode);
    } catch {
      return null;
    }
  }));
  return resolved.filter(Boolean);
}

export function beginPlaybackSession(profileId, input, database = getDatabase()) {
  requireProfile(profileId, database);
  const media = normalizeMedia(input);
  const reset = input?.reset === true;
  const writerToken = randomUUID();
  const updatedAt = Date.now();
  const transaction = database.transaction(() => {
    const existing = getProgress(profileId, media, database);
    database.prepare(`
      INSERT INTO progress_writers (
        profile_id, media_type, tmdb_id, season_number, episode_number,
        writer_token, last_sequence, title, episode_title, poster_url, backdrop_url, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
      ON CONFLICT(profile_id, media_type, tmdb_id, season_number, episode_number)
      DO UPDATE SET writer_token = excluded.writer_token, last_sequence = 0,
        title = excluded.title, episode_title = excluded.episode_title,
        poster_url = excluded.poster_url, backdrop_url = excluded.backdrop_url,
        updated_at = excluded.updated_at
    `).run(
      ...identityValues(profileId, media), writerToken,
      media.title, media.episodeTitle, media.posterUrl, media.backdropUrl, updatedAt,
    );

    const position = reset ? 0 : existing?.position ?? 0;
    const duration = existing?.duration ?? 0;
    const completed = reset ? false : existing?.completed ?? false;
    database.prepare(`
      INSERT INTO watch_history (
        profile_id, media_type, tmdb_id, season_number, episode_number,
        title, episode_title, poster_url, backdrop_url,
        position_seconds, duration_seconds, completed, last_watched_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(profile_id, media_type, tmdb_id, season_number, episode_number)
      DO UPDATE SET title = excluded.title, episode_title = excluded.episode_title,
        poster_url = excluded.poster_url, backdrop_url = excluded.backdrop_url,
        position_seconds = excluded.position_seconds, duration_seconds = excluded.duration_seconds,
        completed = excluded.completed, last_watched_at = excluded.last_watched_at
    `).run(
      ...identityValues(profileId, media), media.title, media.episodeTitle,
      media.posterUrl, media.backdropUrl, position, duration, completed ? 1 : 0, updatedAt,
    );
    return { writerToken, progress: getProgress(profileId, media, database) };
  });
  return transaction();
}

export function calculateCompleted(position, duration) {
  if (!(duration > 0) || !(position > 0)) return false;
  const ratio = position / duration;
  return ratio >= COMPLETION_RATIO
    || (ratio >= COMPLETION_REMAINING_MIN_RATIO && duration - position <= COMPLETION_REMAINING_SECONDS);
}

export function saveProgress(profileId, input, database = getDatabase()) {
  requireProfile(profileId, database);
  const writerToken = typeof input?.writerToken === "string" ? input.writerToken : "";
  const sequence = Number(input?.sequence);
  const rawPosition = Number(input?.position);
  const duration = Number(input?.duration);
  const reset = input?.reset === true;
  if (!writerToken || !Number.isInteger(sequence) || sequence < 1) {
    throw new HistoryError("Progress writer token and sequence are required.");
  }
  if (!Number.isFinite(rawPosition) || !Number.isFinite(duration) || duration <= 0) {
    throw new HistoryError("Progress position and duration must be finite positive values.");
  }
  const position = reset ? 0 : Math.max(0, Math.min(rawPosition, duration));
  const transaction = database.transaction(() => {
    const writer = database.prepare("SELECT * FROM progress_writers WHERE profile_id = ? AND writer_token = ?")
      .get(profileId, writerToken);
    if (!writer || sequence <= writer.last_sequence) return { applied: false, progress: null };
    database.prepare(`
      UPDATE progress_writers SET last_sequence = ?, updated_at = ?
      WHERE profile_id = ? AND writer_token = ?
    `).run(sequence, Date.now(), profileId, writerToken);

    const identity = {
      mediaType: writer.media_type,
      tmdbId: writer.tmdb_id,
      seasonNumber: writer.season_number,
      episodeNumber: writer.episode_number,
    };
    const existing = getProgress(profileId, identity, database);
    if (position <= 0 && !reset) return { applied: true, progress: existing };
    const completed = reset ? false : calculateCompleted(position, duration);
    const lastWatchedAt = Date.now();
    database.prepare(`
      INSERT INTO watch_history (
        profile_id, media_type, tmdb_id, season_number, episode_number,
        title, episode_title, poster_url, backdrop_url,
        position_seconds, duration_seconds, completed, last_watched_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(profile_id, media_type, tmdb_id, season_number, episode_number)
      DO UPDATE SET title = excluded.title, episode_title = excluded.episode_title,
        poster_url = excluded.poster_url, backdrop_url = excluded.backdrop_url,
        position_seconds = excluded.position_seconds, duration_seconds = excluded.duration_seconds,
        completed = excluded.completed, last_watched_at = excluded.last_watched_at
    `).run(
      ...identityValues(profileId, identity), writer.title, writer.episode_title,
      writer.poster_url, writer.backdrop_url, position, duration, completed ? 1 : 0, lastWatchedAt,
    );
    return { applied: true, progress: getProgress(profileId, identity, database) };
  });
  return transaction();
}

export function removeHistory(profileId, input, database = getDatabase()) {
  requireProfile(profileId, database);
  const identity = normalizeMediaIdentity(input);
  const transaction = database.transaction(() => {
    const values = identityValues(profileId, identity);
    database.prepare(`DELETE FROM progress_writers WHERE profile_id = ? AND media_type = ? AND tmdb_id = ? AND season_number = ? AND episode_number = ?`).run(...values);
    return database.prepare(`DELETE FROM watch_history WHERE profile_id = ? AND media_type = ? AND tmdb_id = ? AND season_number = ? AND episode_number = ?`).run(...values).changes > 0;
  });
  return transaction();
}

export function removeTitleHistory(profileId, input, database = getDatabase()) {
  requireProfile(profileId, database);
  const mediaType = input?.mediaType === "tv" ? "tv" : input?.mediaType === "movie" ? "movie" : null;
  if (!mediaType) throw new HistoryError("Media type must be movie or tv.");
  const tmdbId = integer(input?.tmdbId, "TMDB ID");
  const transaction = database.transaction(() => {
    const values = [profileId, mediaType, tmdbId];
    database.prepare(`
      DELETE FROM progress_writers
      WHERE profile_id = ? AND media_type = ? AND tmdb_id = ?
    `).run(...values);
    return database.prepare(`
      DELETE FROM watch_history
      WHERE profile_id = ? AND media_type = ? AND tmdb_id = ?
    `).run(...values).changes > 0;
  });
  return transaction();
}
