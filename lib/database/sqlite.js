import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const databasesKey = Symbol.for("torplay.sqliteDatabases");

function databasePath() {
  const configured = process.env.TORPLAY_DATABASE_PATH?.trim() || "persistent-data/torplay.db";
  return configured === ":memory:"
    ? configured
    : path.resolve(/* turbopackIgnore: true */ process.cwd(), configured);
}

function migrate(database) {
  database.pragma("foreign_keys = ON");
  database.pragma("journal_mode = WAL");
  database.pragma("busy_timeout = 5000");
  database.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS watch_history (
      profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      media_type TEXT NOT NULL CHECK (media_type IN ('movie', 'tv')),
      tmdb_id INTEGER NOT NULL,
      season_number INTEGER NOT NULL DEFAULT -1,
      episode_number INTEGER NOT NULL DEFAULT -1,
      title TEXT NOT NULL,
      episode_title TEXT,
      poster_url TEXT,
      backdrop_url TEXT,
      position_seconds REAL NOT NULL,
      duration_seconds REAL NOT NULL,
      completed INTEGER NOT NULL DEFAULT 0,
      last_watched_at INTEGER NOT NULL,
      PRIMARY KEY (profile_id, media_type, tmdb_id, season_number, episode_number)
    );

    CREATE TABLE IF NOT EXISTS progress_writers (
      profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      media_type TEXT NOT NULL CHECK (media_type IN ('movie', 'tv')),
      tmdb_id INTEGER NOT NULL,
      season_number INTEGER NOT NULL DEFAULT -1,
      episode_number INTEGER NOT NULL DEFAULT -1,
      writer_token TEXT NOT NULL,
      last_sequence INTEGER NOT NULL DEFAULT 0,
      title TEXT NOT NULL,
      episode_title TEXT,
      poster_url TEXT,
      backdrop_url TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (profile_id, media_type, tmdb_id, season_number, episode_number)
    );

    CREATE INDEX IF NOT EXISTS watch_history_profile_recent
      ON watch_history(profile_id, last_watched_at DESC);
  `);
  const version = database.pragma("user_version", { simple: true });
  if (version < 2) {
    database.exec(`
      INSERT INTO watch_history (
        profile_id, media_type, tmdb_id, season_number, episode_number,
        title, episode_title, poster_url, backdrop_url,
        position_seconds, duration_seconds, completed, last_watched_at
      )
      SELECT
        writer.profile_id, writer.media_type, writer.tmdb_id,
        writer.season_number, writer.episode_number,
        writer.title, writer.episode_title, writer.poster_url, writer.backdrop_url,
        0, 0, 0, writer.updated_at
      FROM progress_writers AS writer
      WHERE NOT EXISTS (
        SELECT 1 FROM watch_history AS history
        WHERE history.profile_id = writer.profile_id
          AND history.media_type = writer.media_type
          AND history.tmdb_id = writer.tmdb_id
          AND history.season_number = writer.season_number
          AND history.episode_number = writer.episode_number
      );
    `);
    database.pragma("user_version = 2");
  }
  return database;
}

export function createDatabase(filename = databasePath()) {
  if (filename !== ":memory:") mkdirSync(path.dirname(filename), { recursive: true });
  return migrate(new Database(filename));
}

export function getDatabase() {
  globalThis[databasesKey] ??= new Map();
  const filename = databasePath();
  if (!globalThis[databasesKey].has(filename)) {
    globalThis[databasesKey].set(filename, createDatabase(filename));
  }
  return globalThis[databasesKey].get(filename);
}

export function closeDatabases() {
  for (const database of globalThis[databasesKey]?.values() || []) database.close();
  globalThis[databasesKey]?.clear();
}
