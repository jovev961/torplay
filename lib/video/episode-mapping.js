import path from "node:path";
import { getDatabase } from "../database/sqlite.js";
import { findEpisodeFile, isExtraMediaFile, safeTorrentRelativePath } from "./episode.js";

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

export function saveEpisodeFileMapping(infoHash, context, file, database = getDatabase(), source = "manual") {
  const key = identity(infoHash, context);
  const relativePath = filePath(file);
  const size = Number(file?.size);
  if (!key || !relativePath || !Number.isSafeInteger(size) || size <= 0) {
    throw new Error("A valid show episode and video file are required.");
  }
  if (!["manual", "filename-match", "episode-list"].includes(source)) {
    throw new Error("Invalid episode mapping source.");
  }
  database.prepare(`INSERT INTO episode_file_mappings
    (info_hash, tmdb_id, season_number, episode_number, relative_path, file_size, source, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(info_hash, tmdb_id, season_number, episode_number) DO UPDATE SET
      relative_path = excluded.relative_path, file_size = excluded.file_size,
      source = excluded.source, updated_at = excluded.updated_at
    WHERE excluded.source = 'manual'`).run(...key, relativePath, size, source, Date.now());
}

export function replaceEpisodeFileMappings(infoHash, context, file, previousMappings,
  database = getDatabase()) {
  const key = identity(infoHash, context);
  const relativePath = filePath(file);
  const size = Number(file?.size);
  if (!key || !relativePath || !Number.isSafeInteger(size) || size <= 0) {
    throw new Error("A valid show episode and video file are required.");
  }
  database.transaction(() => {
    const remove = database.prepare(`DELETE FROM episode_file_mappings
      WHERE info_hash = ? AND tmdb_id = ? AND season_number = ? AND episode_number = ?`);
    for (const mapping of previousMappings) {
      remove.run(key[0], key[1], mapping.season, mapping.episode);
    }
    saveEpisodeFileMapping(infoHash, context, file, database);
  })();
}

export function mappedEpisodeFile(infoHash, context, files, season = context?.season,
  episode = context?.episode, database = null, source = null) {
  const key = identity(infoHash, context, season, episode);
  if (!key || !Array.isArray(files)) return null;
  const db = database || getDatabase();
  const row = db.prepare(`SELECT relative_path, file_size, source FROM episode_file_mappings
    WHERE info_hash = ? AND tmdb_id = ? AND season_number = ? AND episode_number = ?`).get(...key);
  if (!row || (source && row.source !== source)) return null;
  const exact = files.filter((file) => filePath(file) === row.relative_path && Number(file.size) === row.file_size);
  if (exact.length === 1) return exact[0];
  const basename = path.posix.basename(row.relative_path);
  const fallback = files.filter((file) => path.posix.basename(filePath(file)) === basename
    && Number(file.size) === row.file_size);
  return fallback.length === 1 ? fallback[0] : null;
}

export function resolveEpisodeFile(infoHash, context, files, season = context?.season,
  episode = context?.episode, options = {}) {
  const manual = mappedEpisodeFile(infoHash, context, files, season, episode, options.database, "manual");
  if (manual) return manual;
  const filenameMatch = findEpisodeFile(files, Number(season), Number(episode), options);
  if (filenameMatch) {
    const db = options.database || getDatabase();
    const assignedElsewhere = db.prepare(`SELECT 1 FROM episode_file_mappings
      WHERE info_hash = ? AND tmdb_id = ? AND relative_path = ? AND file_size = ?
      AND source = 'manual' AND (season_number != ? OR episode_number != ?) LIMIT 1`)
      .get(String(infoHash).toLowerCase(), Number(context?.tmdbId), filePath(filenameMatch),
        Number(filenameMatch.size), Number(season), Number(episode));
    if (!assignedElsewhere) return filenameMatch;
  }
  return mappedEpisodeFile(infoHash, context, files, season, episode, options.database);
}

export function episodeMappingsForFiles(infoHash, context, files, database = null) {
  const key = identity(infoHash, context, context?.season ?? 0, 1);
  if (!key) return [];
  const db = database || getDatabase();
  const rows = db.prepare(`SELECT season_number, episode_number, source FROM episode_file_mappings
    WHERE info_hash = ? AND tmdb_id = ?`).all(key[0], key[1]);
  return rows.flatMap((row) => {
    const file = mappedEpisodeFile(infoHash, context, files, row.season_number, row.episode_number, db);
    return file ? [{ fileId: String(file.providerId ?? file.id), season: row.season_number,
      episode: row.episode_number, source: row.source }] : [];
  });
}

function normalizedWords(value) {
  return String(value || "").slice(0, 256).normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function autoMapEpisodeFiles(infoHash, context, files, episodeList = [], database = getDatabase()) {
  if (!identity(infoHash, context, context?.season ?? 0, 1) || !Array.isArray(files)) return;
  const manuallyMapped = database.prepare(`SELECT relative_path, file_size FROM episode_file_mappings
    WHERE info_hash = ? AND tmdb_id = ? AND source = 'manual'`)
    .all(String(infoHash).toLowerCase(), Number(context.tmdbId));
  const eligible = files.filter((file) => !isExtraMediaFile(file)
    && !manuallyMapped.some((entry) => filePath(file) === entry.relative_path
      && Number(file.size) === entry.file_size));
  const seasons = new Set([Number(context.season)]);
  for (const file of eligible) {
    const value = filePath(file);
    for (const match of value.matchAll(/(?:^|[^a-z\d])s(\d{1,2})[\s._-]*e\d{1,3}/gi)) seasons.add(Number(match[1]));
  }
  const filenameMatched = new Set();
  for (const season of seasons) {
    if (!Number.isInteger(season) || season < 0 || season > 99) continue;
    for (let episode = 1; episode <= 200; episode += 1) {
      const file = findEpisodeFile(eligible, season, episode, { allowSingleFileFallback: false });
      if (!file) continue;
      filenameMatched.add(file);
      saveEpisodeFileMapping(infoHash, { ...context, season, episode }, file, database, "filename-match");
    }
  }
  const titles = episodeList.map((entry) => ({ number: Number(entry.number), words: normalizedWords(entry.title) }))
    .filter((entry) => Number.isInteger(entry.number) && entry.number > 0
      && entry.words.length >= 8 && entry.words.split(" ").length >= 2
      && !/^episode \d+$/.test(entry.words));
  for (const entry of titles) {
    if (titles.filter((other) => other.words === entry.words).length !== 1) continue;
    const candidates = eligible.filter((file) => !filenameMatched.has(file)
      && ` ${normalizedWords(path.posix.basename(filePath(file), path.posix.extname(filePath(file))))} `
        .includes(` ${entry.words} `));
    if (candidates.length !== 1) continue;
    const competing = titles.filter((other) => other !== entry
      && ` ${normalizedWords(candidates[0].name)} `.includes(` ${other.words} `));
    if (competing.length) continue;
    saveEpisodeFileMapping(infoHash, { ...context, episode: entry.number }, candidates[0], database,
      "episode-list");
  }
}
