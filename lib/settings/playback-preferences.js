import { getDatabase } from "../database/sqlite.js";
import { SettingsError } from "./config.js";

const PLAYBACK_FIELDS = {
  autoSkipIntrosRecaps: "TORPLAY_AUTO_SKIP_INTRO_RECAP",
  autoPlayNextEpisode: "TORPLAY_AUTO_PLAY_NEXT_EPISODE",
};

function environmentDefaults(environment) {
  return Object.fromEntries(Object.entries(PLAYBACK_FIELDS).map(([key, variable]) => [
    key, ["true", "1"].includes(String(environment[variable] || "").toLowerCase()),
  ]));
}

export function playbackPreferences(environment = process.env, database = getDatabase()) {
  const preferences = environmentDefaults(environment);
  const rows = database.prepare(`SELECT key, value FROM app_preferences
    WHERE key IN ('autoSkipIntrosRecaps', 'autoPlayNextEpisode')`).all();
  for (const row of rows) preferences[row.key] = row.value === "true";
  return preferences;
}

export function updatePlaybackPreferences(values, {
  environment = process.env,
  database = getDatabase(),
} = {}) {
  if (!values || Object.keys(values).length !== 2
    || Object.keys(PLAYBACK_FIELDS).some((key) => typeof values[key] !== "boolean")) {
    throw new SettingsError("Both playback preferences must be true or false.");
  }
  const update = database.prepare(`INSERT INTO app_preferences (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`);
  const save = database.transaction(() => {
    const now = Date.now();
    for (const key of Object.keys(PLAYBACK_FIELDS)) update.run(key, String(values[key]), now);
  });
  save();
  return playbackPreferences(environment, database);
}
