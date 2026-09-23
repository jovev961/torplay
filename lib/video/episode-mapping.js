import path from "node:path";
import { getDatabase } from "../database/sqlite.js";
import { findEpisodeFile, safeTorrentRelativePath } from "./episode.js";

function identity(infoHash, context, season = context?.season, episode = context?.episode) {
  const hash = String(infoHash || "").toLowerCase();
  const tmdbId = Number(context?.tmdbId);
  const seasonNumber = Number(season);
  const episodeNumber = Number(episode);
  if (!/^[a-f0-9]{40}$/.test(hash) || context?.type !== "show"
    || !Number.isSafeInteger(tmdbId) || tmdbId < 1
    || !Number.isSafeInteger(seasonNumber) || seasonNumber < 0
    || !Number.isSafeInteger(episodeNumber) || episodeNumber < 1) return null;
  return [hash, tmdbId, seasonNumber, episodeNumber];
}

function filePath(file) {
  const value = file?.relativePath || file?.path || file?.name;
  return safeTorrentRelativePath(value, "");
}

export function saveEpisodeFileMapping(infoHash, context, file, database = getDatabase()) {
  const key = identity(infoHash, context);
  const relativePath = filePath(file);
  const size = Number(file?.size);
  if (!key || !relativePath || !Number.isSafeInteger(size) || size <= 0) {
    throw new Error("A valid show episode and video file are required.");
  }
  database.prepare(`INSERT INTO episode_file_mappings
    (info_hash, tmdb_id, season_number, episode_number, relative_path, file_size, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(info_hash, tmdb_id, season_number, episode_number) DO UPDATE SET
      relative_path = excluded.relative_path, file_size = excluded.file_size,
      updated_at = excluded.updated_at`).run(...key, relativePath, size, Date.now());
}

export function mappedEpisodeFile(infoHash, context, files, season = context?.season,
  episode = context?.episode, database = null) {
  const key = identity(infoHash, context, season, episode);
  if (!key || !Array.isArray(files)) return null;
  const db = database || getDatabase();
  const row = db.prepare(`SELECT relative_path, file_size FROM episode_file_mappings
    WHERE info_hash = ? AND tmdb_id = ? AND season_number = ? AND episode_number = ?`).get(...key);
  if (!row) return null;
  const exact = files.filter((file) => filePath(file) === row.relative_path && Number(file.size) === row.file_size);
  if (exact.length === 1) return exact[0];
  const basename = path.posix.basename(row.relative_path);
  const fallback = files.filter((file) => path.posix.basename(filePath(file)) === basename
    && Number(file.size) === row.file_size);
  return fallback.length === 1 ? fallback[0] : null;
}

export function resolveEpisodeFile(infoHash, context, files, season = context?.season,
  episode = context?.episode, options = {}) {
  return mappedEpisodeFile(infoHash, context, files, season, episode, options.database)
    || findEpisodeFile(files, Number(season), Number(episode), options);
}

export function episodeMappingsForFiles(infoHash, context, files, database = null) {
  const key = identity(infoHash, context);
  if (!key) return [];
  const db = database || getDatabase();
  const rows = db.prepare(`SELECT season_number, episode_number FROM episode_file_mappings
    WHERE info_hash = ? AND tmdb_id = ?`).all(key[0], key[1]);
  return rows.flatMap((row) => {
    const file = mappedEpisodeFile(infoHash, context, files, row.season_number, row.episode_number, db);
    return file ? [{ fileId: String(file.providerId ?? file.id), season: row.season_number,
      episode: row.episode_number }] : [];
  });
}
