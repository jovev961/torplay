import { randomUUID } from "node:crypto";
import { getDatabase } from "../database/sqlite.js";
import {
  defaultSubtitlePreferences,
  normalizeSubtitlePreferences,
} from "../subtitles/preferences.js";

export class ProfileError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "ProfileError";
    this.status = status;
  }
}

function normalizeName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) throw new ProfileError("Profile name is required.");
  if (name.length > 50) throw new ProfileError("Profile name must be 50 characters or fewer.");
  return name;
}

function publicProfile(row) {
  let subtitlePreferences = defaultSubtitlePreferences();
  if (row) {
    try {
      subtitlePreferences = normalizeSubtitlePreferences({
        defaultLanguage: row.subtitle_default_language,
        enabledLanguages: JSON.parse(row.subtitle_languages),
      });
    } catch {}
  }
  return row ? {
    id: row.id,
    name: row.name,
    subtitlePreferences,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } : null;
}

export function listProfiles(database = getDatabase()) {
  return database.prepare("SELECT * FROM profiles ORDER BY created_at, name").all().map(publicProfile);
}

export function getProfile(id, database = getDatabase()) {
  if (typeof id !== "string" || !id) return null;
  return publicProfile(database.prepare("SELECT * FROM profiles WHERE id = ?").get(id));
}

export function createProfile(input, database = getDatabase()) {
  const now = Date.now();
  const subtitlePreferences = defaultSubtitlePreferences();
  const profile = {
    id: randomUUID(),
    name: normalizeName(input?.name),
    subtitleDefaultLanguage: subtitlePreferences.defaultLanguage,
    subtitleLanguages: JSON.stringify(subtitlePreferences.enabledLanguages),
    createdAt: now,
    updatedAt: now,
  };
  database.prepare(`
    INSERT INTO profiles (
      id, name, subtitle_default_language, subtitle_languages, created_at, updated_at
    ) VALUES (
      @id, @name, @subtitleDefaultLanguage, @subtitleLanguages, @createdAt, @updatedAt
    )
  `).run(profile);
  return getProfile(profile.id, database);
}

export function renameProfile(id, input, database = getDatabase()) {
  const name = normalizeName(input?.name);
  const updatedAt = Date.now();
  const result = database.prepare("UPDATE profiles SET name = ?, updated_at = ? WHERE id = ?")
    .run(name, updatedAt, id);
  if (!result.changes) throw new ProfileError("Profile not found.", 404);
  return getProfile(id, database);
}

export function updateSubtitlePreferences(id, input, database = getDatabase()) {
  let preferences;
  try {
    preferences = normalizeSubtitlePreferences(input);
  } catch (error) {
    throw new ProfileError(error.message);
  }
  const updatedAt = Date.now();
  const result = database.prepare(`
    UPDATE profiles
    SET subtitle_default_language = ?, subtitle_languages = ?, updated_at = ?
    WHERE id = ?
  `).run(
    preferences.defaultLanguage,
    JSON.stringify(preferences.enabledLanguages),
    updatedAt,
    id,
  );
  if (!result.changes) throw new ProfileError("Profile not found.", 404);
  return getProfile(id, database);
}

export function deleteProfile(id, database = getDatabase()) {
  return database.prepare("DELETE FROM profiles WHERE id = ?").run(id).changes > 0;
}
