import { randomUUID } from "node:crypto";
import { getDatabase } from "../database/sqlite.js";
import {
  availableProfileAvatarId,
  defaultProfileAvatarId,
  isProfileAvatarId,
} from "./avatar-files.js";
import { normalizeProfileAvatarId } from "./avatars.js";
import {
  defaultSubtitlePreferences,
  normalizeSubtitlePreferences,
} from "../subtitles/preferences.js";
import { normalizeAudioPreference, ORIGINAL_AUDIO_LANGUAGE } from "../video/audio-tracks.js";

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

function normalizeAvatarId(value, fallback) {
  if (value === undefined && fallback) return availableProfileAvatarId(fallback);
  if (!isProfileAvatarId(value)) throw new ProfileError("Choose a valid profile avatar.");
  return normalizeProfileAvatarId(value);
}

function publicProfile(row) {
  let subtitlePreferences = defaultSubtitlePreferences();
  let preferredAudioLanguage = ORIGINAL_AUDIO_LANGUAGE;
  if (row) {
    try {
      subtitlePreferences = normalizeSubtitlePreferences({
        defaultLanguage: row.subtitle_default_language,
        enabledLanguages: JSON.parse(row.subtitle_languages),
      });
    } catch {}
    try { preferredAudioLanguage = normalizeAudioPreference(row.audio_preferred_language); } catch {}
  }
  return row ? {
    id: row.id,
    name: row.name,
    avatarId: availableProfileAvatarId(row.avatar_id, row.id),
    subtitlePreferences,
    audioPreferences: {
      preferredLanguage: preferredAudioLanguage,
    },
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
  const subtitlePreferences = { defaultLanguage: "en", enabledLanguages: ["en"] };
  const id = randomUUID();
  const profile = {
    id,
    name: normalizeName(input?.name),
    avatarId: normalizeAvatarId(input?.avatarId, defaultProfileAvatarId(id)),
    subtitleDefaultLanguage: subtitlePreferences.defaultLanguage,
    subtitleLanguages: JSON.stringify(subtitlePreferences.enabledLanguages),
    audioPreferredLanguage: ORIGINAL_AUDIO_LANGUAGE,
    createdAt: now,
    updatedAt: now,
  };
  database.prepare(`
    INSERT INTO profiles (
      id, name, avatar_id, subtitle_default_language, subtitle_languages,
      audio_preferred_language, created_at, updated_at
    ) VALUES (
      @id, @name, @avatarId, @subtitleDefaultLanguage, @subtitleLanguages,
      @audioPreferredLanguage, @createdAt, @updatedAt
    )
  `).run(profile);
  return getProfile(profile.id, database);
}

export function updateProfile(id, input, database = getDatabase()) {
  const current = getProfile(id, database);
  if (!current) throw new ProfileError("Profile not found.", 404);
  const name = input?.name === undefined ? current.name : normalizeName(input.name);
  const avatarId = normalizeAvatarId(input?.avatarId, current.avatarId);
  const updatedAt = Date.now();
  database.prepare("UPDATE profiles SET name = ?, avatar_id = ?, updated_at = ? WHERE id = ?")
    .run(name, avatarId, updatedAt, id);
  return getProfile(id, database);
}

export function renameProfile(id, input, database = getDatabase()) {
  return updateProfile(id, { name: input?.name }, database);
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

export function updateAudioPreferences(id, input, database = getDatabase()) {
  let preferredLanguage;
  try {
    preferredLanguage = normalizeAudioPreference(input?.preferredLanguage);
  } catch (error) {
    throw new ProfileError(error.message);
  }
  const result = database.prepare(`
    UPDATE profiles
    SET audio_preferred_language = ?, updated_at = ?
    WHERE id = ?
  `).run(preferredLanguage, Date.now(), id);
  if (!result.changes) throw new ProfileError("Profile not found.", 404);
  return getProfile(id, database);
}

export function deleteProfile(id, database = getDatabase()) {
  return database.prepare("DELETE FROM profiles WHERE id = ?").run(id).changes > 0;
}
