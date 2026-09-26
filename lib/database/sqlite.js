import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { defaultProfileAvatarId } from "../profiles/avatar-files.js";
import { legacySubtitlePreferences } from "../subtitles/preferences.js";

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
      avatar_id TEXT NOT NULL DEFAULT 'cinema-dog.png',
      subtitle_default_language TEXT NOT NULL DEFAULT 'en',
      subtitle_languages TEXT NOT NULL DEFAULT '["en","mk","sr","hr","bs"]',
      audio_preferred_language TEXT NOT NULL DEFAULT 'original',
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
  if (version < 3) {
    const columns = new Set(database.pragma("table_info(profiles)").map((column) => column.name));
    if (!columns.has("subtitle_default_language")) {
      database.exec("ALTER TABLE profiles ADD COLUMN subtitle_default_language TEXT NOT NULL DEFAULT 'en'");
    }
    if (!columns.has("subtitle_languages")) {
      database.exec(`ALTER TABLE profiles ADD COLUMN subtitle_languages TEXT NOT NULL DEFAULT '["en","mk","sr","hr","bs"]'`);
    }
    const preferences = legacySubtitlePreferences();
    database.prepare(`
      UPDATE profiles
      SET subtitle_default_language = ?, subtitle_languages = ?
    `).run(preferences.defaultLanguage, JSON.stringify(preferences.enabledLanguages));
    database.pragma("user_version = 3");
  }
  if (version < 4) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS imdb_rating_cache (
        media_type TEXT NOT NULL CHECK (media_type IN ('movie', 'tv')),
        tmdb_id INTEGER NOT NULL,
        imdb_id TEXT,
        rating REAL CHECK (rating IS NULL OR (rating >= 0 AND rating <= 10)),
        refreshed_at INTEGER NOT NULL,
        PRIMARY KEY (media_type, tmdb_id)
      );
    `);
    database.pragma("user_version = 4");
  }
  if (version < 5) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS external_response_cache (
        namespace TEXT NOT NULL,
        cache_key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (namespace, cache_key)
      );

      CREATE INDEX IF NOT EXISTS external_response_cache_expiry
        ON external_response_cache(expires_at);
    `);
    database.pragma("user_version = 5");
  }
  if (version < 6) {
    const columns = new Set(database.pragma("table_info(profiles)").map((column) => column.name));
    if (!columns.has("avatar_id")) {
      database.exec("ALTER TABLE profiles ADD COLUMN avatar_id TEXT NOT NULL DEFAULT 'cinema-dog.png'");
    }
    const profiles = database.prepare("SELECT id FROM profiles ORDER BY created_at, name").all();
    const assignAvatar = database.prepare("UPDATE profiles SET avatar_id = ? WHERE id = ?");
    const migrateAvatars = database.transaction(() => {
      profiles.forEach((profile, index) => {
        assignAvatar.run(defaultProfileAvatarId(profile.id, index), profile.id);
      });
    });
    migrateAvatars();
    database.pragma("user_version = 6");
  }
  if (version < 7) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS usenet_jobs (
        id TEXT PRIMARY KEY,
        torbox_id INTEGER NOT NULL,
        account_hash TEXT NOT NULL,
        nzb_hash TEXT NOT NULL,
        title TEXT NOT NULL,
        media_context_json TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE (account_hash, nzb_hash)
      );
    `);
    database.pragma("user_version = 7");
  }
  if (version < 8) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS debrid_resources (
        provider TEXT NOT NULL,
        account_hash TEXT NOT NULL,
        info_hash TEXT NOT NULL,
        resource_id TEXT,
        title TEXT NOT NULL,
        media_context_json TEXT,
        selected_file_id TEXT,
        ownership TEXT NOT NULL DEFAULT 'torplay',
        selection_scope TEXT NOT NULL DEFAULT 'episode',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (provider, account_hash, info_hash, selection_scope)
      );
      CREATE INDEX IF NOT EXISTS debrid_resources_id
        ON debrid_resources (provider, account_hash, resource_id);
    `);
    database.pragma("user_version = 8");
  }
  if (version < 9) {
    const columns = new Set(database.pragma("table_info(debrid_resources)").map((column) => column.name));
    if (!columns.has("ownership")) database.exec("ALTER TABLE debrid_resources ADD COLUMN ownership TEXT NOT NULL DEFAULT 'torplay'");
    database.pragma("user_version = 9");
  }
  if (version < 10) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS debrid_submission_locks (
        provider TEXT NOT NULL,
        account_hash TEXT NOT NULL,
        info_hash TEXT NOT NULL,
        owner_token TEXT NOT NULL,
        lease_until INTEGER NOT NULL,
        PRIMARY KEY (provider, account_hash, info_hash)
      );
    `);
    database.pragma("user_version = 10");
  }
  if (version < 11) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS episode_file_mappings (
        info_hash TEXT NOT NULL,
        tmdb_id INTEGER NOT NULL,
        season_number INTEGER NOT NULL,
        episode_number INTEGER NOT NULL,
        relative_path TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (info_hash, tmdb_id, season_number, episode_number)
      );
    `);
    const columns = new Set(database.pragma("table_info(debrid_resources)").map((column) => column.name));
    if (!columns.has("selection_file_ids_json")) {
      database.exec("ALTER TABLE debrid_resources ADD COLUMN selection_file_ids_json TEXT");
    }
    database.pragma("user_version = 11");
  }
  if (version < 12) {
    const columns = new Set(database.pragma("table_info(episode_file_mappings)").map((column) => column.name));
    if (!columns.has("source")) {
      database.exec("ALTER TABLE episode_file_mappings ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'");
    }
    database.exec(`
      CREATE TABLE IF NOT EXISTS debrid_media_links (
        provider TEXT NOT NULL,
        account_hash TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        info_hash TEXT NOT NULL,
        media_type TEXT NOT NULL CHECK (media_type IN ('movie', 'show')),
        tmdb_id INTEGER NOT NULL,
        media_context_json TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('torplay', 'manual')),
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (provider, account_hash, resource_id)
      );
      CREATE INDEX IF NOT EXISTS debrid_media_links_lookup
        ON debrid_media_links (media_type, tmdb_id, provider);
    `);
    const rows = database.prepare(`SELECT provider, account_hash, resource_id, info_hash, title,
      media_context_json, updated_at FROM debrid_resources
      WHERE resource_id IS NOT NULL AND media_context_json IS NOT NULL`).all();
    const insert = database.prepare(`INSERT OR IGNORE INTO debrid_media_links
      (provider, account_hash, resource_id, info_hash, media_type, tmdb_id,
       media_context_json, source, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'torplay', ?)`);
    for (const row of rows) {
      let context;
      try { context = JSON.parse(row.media_context_json); } catch { continue; }
      if (!["movie", "show"].includes(context?.type)
        || !Number.isSafeInteger(Number(context.tmdbId)) || Number(context.tmdbId) < 1) continue;
      if (context.type === "movie" && (!Number.isSafeInteger(Number(context.year))
        || !String(row.title || "").match(/(?:^|\D)((?:19|20)\d{2})(?!\d)/g)
          ?.some((match) => Number(match.match(/(?:19|20)\d{2}/)?.[0]) === Number(context.year)))) continue;
      insert.run(row.provider, row.account_hash, row.resource_id, row.info_hash,
        context.type, Number(context.tmdbId), row.media_context_json, row.updated_at);
    }
    database.pragma("user_version = 12");
  }
  if (version < 13) {
    const columns = new Set(database.pragma("table_info(profiles)").map((column) => column.name));
    if (!columns.has("audio_preferred_language")) {
      database.exec("ALTER TABLE profiles ADD COLUMN audio_preferred_language TEXT NOT NULL DEFAULT 'original'");
    }
    database.pragma("user_version = 13");
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
