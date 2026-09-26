import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { createDatabase } from "../lib/database/sqlite.js";
import {
  defaultProfileAvatarId,
  isProfileAvatarId,
  listProfileAvatars,
} from "../lib/profiles/avatar-files.js";
import { normalizeProfileAvatarId } from "../lib/profiles/avatars.js";
import {
  beginPlaybackSession,
  calculateCompleted,
  getProgress,
  listContinueWatching,
  listHistory,
  removeHistory,
  removeTitleHistory,
  saveProgress,
} from "../lib/history/service.js";
import {
  createProfile,
  deleteProfile,
  getProfile,
  listProfiles,
  renameProfile,
  updateProfile,
  updateAudioPreferences,
  updateSubtitlePreferences,
} from "../lib/profiles/service.js";

function movie(id, title = `Movie ${id}`) {
  return { mediaType: "movie", tmdbId: id, title };
}

function episode(id, seasonNumber, episodeNumber) {
  return {
    mediaType: "tv",
    tmdbId: id,
    seasonNumber,
    episodeNumber,
    title: `Show ${id}`,
    episodeTitle: `Episode ${episodeNumber}`,
  };
}

function save(database, profileId, media, position, duration, sequence = 1) {
  const writer = beginPlaybackSession(profileId, media, database);
  return saveProgress(profileId, {
    writerToken: writer.writerToken,
    sequence,
    position,
    duration,
  }, database);
}

test("profile avatars are discovered from public profile pictures", () => {
  const avatars = listProfileAvatars();
  assert.ok(avatars.length >= 1);
  assert.equal(new Set(avatars.map((avatar) => avatar.id)).size, avatars.length);
  assert.equal(avatars.every((avatar) => avatar.label && avatar.src.startsWith("/profilePictures/")), true);
  assert.equal(isProfileAvatarId(defaultProfileAvatarId("existing-profile")), true);
  assert.equal(normalizeProfileAvatarId("ocean"), "friendly-robot.png");
});

test("profile avatar discovery reflects files added to and removed from the folder", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "torplay-profile-pictures-"));
  try {
    await writeFile(path.join(directory, "fox.png"), "test");
    await writeFile(path.join(directory, "notes.txt"), "ignored");
    assert.deepEqual(listProfileAvatars(directory).map((avatar) => avatar.id), ["fox.png"]);

    await writeFile(path.join(directory, "owl.webp"), "test");
    assert.deepEqual(listProfileAvatars(directory).map((avatar) => avatar.id), ["fox.png", "owl.webp"]);

    await rm(path.join(directory, "fox.png"));
    assert.deepEqual(listProfileAvatars(directory).map((avatar) => avatar.id), ["owl.webp"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("profiles keep stable IDs through rename and delete their history", () => {
  const database = createDatabase(":memory:");
  try {
    const avatars = listProfileAvatars();
    const firstAvatar = avatars[0].id;
    const secondAvatar = avatars[1]?.id || firstAvatar;
    const profile = createProfile({ name: " Vasil ", avatarId: firstAvatar }, database);
    assert.equal(profile.avatarId, firstAvatar);
    const renamed = renameProfile(profile.id, { name: "Viewer" }, database);
    assert.equal(renamed.id, profile.id);
    assert.equal(renamed.name, "Viewer");
    assert.equal(renamed.avatarId, firstAvatar);
    const customized = updateProfile(profile.id, { avatarId: secondAvatar }, database);
    assert.equal(customized.name, "Viewer");
    assert.equal(customized.avatarId, secondAvatar);
    assert.throws(() => updateProfile(profile.id, { avatarId: "custom-upload" }, database), /valid profile avatar/);
    assert.deepEqual(listProfiles(database).map((item) => item.id), [profile.id]);

    save(database, profile.id, movie(10, "Sintel"), 90, 600);
    assert.equal(listHistory(profile.id, database).length, 1);
    assert.equal(deleteProfile(profile.id, database), true);
    assert.equal(getProfile(profile.id, database), null);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM watch_history").get().count, 0);
  } finally {
    database.close();
  }
});

test("subtitle preferences are validated, persisted, and isolated by profile", () => {
  const database = createDatabase(":memory:");
  try {
    const first = createProfile({ name: "First" }, database);
    const second = createProfile({ name: "Second" }, database);
    assert.equal(isProfileAvatarId(first.avatarId), true);
    assert.throws(() => createProfile({ name: "Invalid", avatarId: "uploaded-image" }, database), /valid profile avatar/);
    assert.deepEqual(first.subtitlePreferences, {
      defaultLanguage: "en",
      enabledLanguages: ["en"],
    });

    const updated = updateSubtitlePreferences(first.id, {
      defaultLanguage: "de",
      enabledLanguages: ["de", "en", "de"],
    }, database);
    assert.deepEqual(updated.subtitlePreferences, {
      defaultLanguage: "de",
      enabledLanguages: ["de", "en"],
    });
    const newest = createProfile({ name: "Newest" }, database);
    assert.deepEqual(newest.subtitlePreferences, { defaultLanguage: "en", enabledLanguages: ["en"] });
    assert.deepEqual(getProfile(first.id, database).subtitlePreferences, updated.subtitlePreferences);
    assert.deepEqual(getProfile(second.id, database).subtitlePreferences, {
      defaultLanguage: "en",
      enabledLanguages: ["en"],
    });
    assert.throws(() => updateSubtitlePreferences(first.id, {
      defaultLanguage: "fr",
      enabledLanguages: ["en"],
    }, database), /must also be enabled/);
    assert.throws(() => updateSubtitlePreferences(first.id, {
      defaultLanguage: "en",
      enabledLanguages: [],
    }, database), /at least one/);
  } finally {
    database.close();
  }
});

test("audio preferences default to original and remain isolated by profile", () => {
  const database = createDatabase(":memory:");
  try {
    const first = createProfile({ name: "First" }, database);
    const second = createProfile({ name: "Second" }, database);
    assert.deepEqual(first.audioPreferences, { preferredLanguage: "original" });
    const updated = updateAudioPreferences(first.id, { preferredLanguage: "eng" }, database);
    assert.deepEqual(updated.audioPreferences, { preferredLanguage: "en" });
    assert.deepEqual(getProfile(second.id, database).audioPreferences, { preferredLanguage: "original" });
    assert.throws(
      () => updateAudioPreferences(first.id, { preferredLanguage: "not-a-language" }, database),
      /valid preferred audio language/,
    );
  } finally {
    database.close();
  }
});

test("movie and episode progress is isolated by profile and stable media identity", () => {
  const database = createDatabase(":memory:");
  try {
    const first = createProfile({ name: "First" }, database);
    const second = createProfile({ name: "Second" }, database);
    save(database, first.id, movie(20), 120, 1_000);
    save(database, second.id, movie(20), 450, 1_000);
    save(database, first.id, episode(30, 2, 5), 300, 1_800);

    assert.equal(getProgress(first.id, movie(20), database).position, 120);
    assert.equal(getProgress(second.id, movie(20), database).position, 450);
    assert.equal(getProgress(second.id, episode(30, 2, 5), database), null);
    assert.equal(getProgress(first.id, episode(30, 2, 5), database).episodeTitle, "Episode 5");

    const replacementSource = beginPlaybackSession(first.id, movie(20), database);
    assert.equal(replacementSource.progress.position, 120);
  } finally {
    database.close();
  }
});

test("opening a player creates a zero-position Continue Watching entry", async () => {
  const database = createDatabase(":memory:");
  try {
    const profile = createProfile({ name: "Viewer" }, database);
    const media = episode(31, 1, 3);
    const started = beginPlaybackSession(profile.id, media, database);

    assert.equal(started.progress.position, 0);
    assert.equal(started.progress.duration, 0);
    assert.equal(started.progress.completed, false);
    assert.deepEqual((await listContinueWatching(profile.id, database)).map((item) => item.episodeNumber), [3]);

    saveProgress(profile.id, {
      writerToken: started.writerToken,
      sequence: 1,
      position: 75,
      duration: 1_000,
    }, database);
    assert.equal(beginPlaybackSession(profile.id, media, database).progress.position, 75);

    const restarted = beginPlaybackSession(profile.id, { ...media, reset: true }, database);
    assert.equal(restarted.progress.position, 0);
    assert.equal(restarted.progress.duration, 1_000);
    assert.equal(restarted.progress.completed, false);
  } finally {
    database.close();
  }
});

test("database migration restores started media that only has a progress writer", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "torplay-history-"));
  const filename = path.join(directory, "legacy.db");
  let database;
  try {
    database = createDatabase(filename);
    const profile = createProfile({ name: "Viewer" }, database);
    database.prepare(`
      INSERT INTO progress_writers (
        profile_id, media_type, tmdb_id, season_number, episode_number,
        writer_token, last_sequence, title, episode_title, poster_url, backdrop_url, updated_at
      ) VALUES (?, 'tv', 69050, 1, 3, 'legacy-writer', 0, 'Riverdale',
        'Chapter Three: Body Double', NULL, NULL, 1234)
    `).run(profile.id);
    database.pragma("user_version = 1");
    database.close();
    database = null;

    database = createDatabase(filename);
    const restored = getProgress(profile.id, episode(69050, 1, 3), database);
    assert.equal(restored.position, 0);
    assert.equal(restored.duration, 0);
    assert.equal(restored.episodeTitle, "Chapter Three: Body Double");
    assert.equal(database.pragma("user_version", { simple: true }), 13);
  } finally {
    database?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("database migration assigns built-in avatars without replacing profile data", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "torplay-profile-avatars-"));
  const filename = path.join(directory, "legacy.db");
  let database;
  try {
    const legacy = new Database(filename);
    legacy.exec(`
      CREATE TABLE profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        subtitle_default_language TEXT NOT NULL DEFAULT 'en',
        subtitle_languages TEXT NOT NULL DEFAULT '["en"]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO profiles VALUES ('legacy-one', 'Vasil', 'en', '["en"]', 1, 1);
      INSERT INTO profiles VALUES ('legacy-two', 'Ema', 'en', '["en"]', 2, 2);
      PRAGMA user_version = 5;
    `);
    legacy.close();

    database = createDatabase(filename);
    const profiles = listProfiles(database);
    assert.deepEqual(profiles.map(({ id, name }) => ({ id, name })), [
      { id: "legacy-one", name: "Vasil" },
      { id: "legacy-two", name: "Ema" },
    ]);
    assert.equal(profiles[0].avatarId, defaultProfileAvatarId("legacy-one", 0));
    assert.equal(profiles[1].avatarId, defaultProfileAvatarId("legacy-two", 1));
    assert.equal(profiles.every((profile) => isProfileAvatarId(profile.avatarId)), true);
    assert.equal(database.pragma("user_version", { simple: true }), 13);
  } finally {
    database?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("database migration imports legacy environment languages once", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "torplay-profile-preferences-"));
  const filename = path.join(directory, "legacy.db");
  const previousDefault = process.env.SUBTITLE_DEFAULT_LANGUAGE;
  const previousLanguages = process.env.SUBTITLE_LANGUAGES;
  let database;
  try {
    database = createDatabase(filename);
    const profile = createProfile({ name: "Viewer" }, database);
    database.pragma("user_version = 2");
    database.close();
    database = null;

    process.env.SUBTITLE_DEFAULT_LANGUAGE = "de";
    process.env.SUBTITLE_LANGUAGES = "de,en,de";
    database = createDatabase(filename);
    assert.deepEqual(getProfile(profile.id, database).subtitlePreferences, {
      defaultLanguage: "de",
      enabledLanguages: ["de", "en"],
    });
    database.close();
    database = null;

    process.env.SUBTITLE_DEFAULT_LANGUAGE = "fr";
    process.env.SUBTITLE_LANGUAGES = "fr";
    database = createDatabase(filename);
    assert.deepEqual(getProfile(profile.id, database).subtitlePreferences, {
      defaultLanguage: "de",
      enabledLanguages: ["de", "en"],
    });
  } finally {
    if (previousDefault === undefined) delete process.env.SUBTITLE_DEFAULT_LANGUAGE;
    else process.env.SUBTITLE_DEFAULT_LANGUAGE = previousDefault;
    if (previousLanguages === undefined) delete process.env.SUBTITLE_LANGUAGES;
    else process.env.SUBTITLE_LANGUAGES = previousLanguages;
    database?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("sequence and writer tokens prevent stale progress from overwriting newer progress", () => {
  const database = createDatabase(":memory:");
  try {
    const profile = createProfile({ name: "Viewer" }, database);
    const media = movie(40);
    const firstWriter = beginPlaybackSession(profile.id, media, database);
    const newer = saveProgress(profile.id, {
      writerToken: firstWriter.writerToken,
      sequence: 2,
      position: 2_100,
      duration: 4_000,
    }, database);
    const stale = saveProgress(profile.id, {
      writerToken: firstWriter.writerToken,
      sequence: 1,
      position: 600,
      duration: 4_000,
    }, database);
    assert.equal(newer.applied, true);
    assert.equal(stale.applied, false);
    assert.equal(getProgress(profile.id, media, database).position, 2_100);

    const currentWriter = beginPlaybackSession(profile.id, media, database);
    assert.equal(saveProgress(profile.id, {
      writerToken: firstWriter.writerToken,
      sequence: 3,
      position: 700,
      duration: 4_000,
    }, database).applied, false);
    saveProgress(profile.id, {
      writerToken: currentWriter.writerToken,
      sequence: 1,
      position: 0,
      duration: 4_000,
      reset: true,
    }, database);
    assert.equal(getProgress(profile.id, media, database).position, 0);
  } finally {
    database.close();
  }
});

test("Continue Watching applies centralized thresholds and recent ordering", async () => {
  const database = createDatabase(":memory:");
  const originalNow = Date.now;
  try {
    const profile = createProfile({ name: "Viewer" }, database);
    let now = 1_000;
    Date.now = () => now;
    save(database, profile.id, movie(1, "Tiny"), 15, 1_000);
    now += 1;
    save(database, profile.id, movie(2, "Older"), 60, 1_000);
    now += 1;
    save(database, profile.id, episode(3, 1, 1), 120, 1_000);
    now += 1;
    save(database, profile.id, movie(4, "Complete"), 960, 1_000);

    assert.deepEqual(
      (await listContinueWatching(profile.id, database)).map((item) => item.title),
      ["Show 3", "Older", "Tiny"],
    );
    assert.equal(listHistory(profile.id, database).length, 4);
    assert.equal(getProgress(profile.id, movie(4), database).completed, true);
    assert.equal(calculateCompleted(800, 1_000), false);
    assert.equal(calculateCompleted(950, 1_000), true);
    assert.equal(calculateCompleted(840, 1_000), true);
  } finally {
    Date.now = originalNow;
    database.close();
  }
});

test("history groups TV episodes by title while preserving episode progress", async () => {
  const database = createDatabase(":memory:");
  const originalNow = Date.now;
  try {
    const profile = createProfile({ name: "Viewer" }, database);
    let now = 2_000;
    Date.now = () => now;
    for (let number = 1; number <= 5; number += 1) {
      save(database, profile.id, episode(77, 1, number), number * 60, 1_000);
      now += 1;
    }
    save(database, profile.id, movie(78), 45, 1_000);

    const history = listHistory(profile.id, database);
    const show = history.find((item) => item.tmdbId === 77);
    assert.equal(history.length, 2);
    assert.equal(show.episodeNumber, 5);
    assert.deepEqual(show.episodes.map((item) => item.episodeNumber), [5, 4, 3, 2, 1]);
    assert.equal((await listContinueWatching(profile.id, database)).filter((item) => item.tmdbId === 77).length, 1);

    now += 1;
    save(database, profile.id, episode(77, 1, 5), 960, 1_000);
    assert.equal((await listContinueWatching(profile.id, database, {
      findNextEpisode: async () => null,
    })).some((item) => item.tmdbId === 77), false);
    assert.equal(getProgress(profile.id, episode(77, 1, 1), database).position, 60);
  } finally {
    Date.now = originalNow;
    database.close();
  }
});

test("Continue Watching advances a completed show to a zero-position next episode", async () => {
  const database = createDatabase(":memory:");
  try {
    const profile = createProfile({ name: "Viewer" }, database);
    const current = {
      ...episode(80, 1, 3),
      posterUrl: "https://images.example/show.jpg",
      backdropUrl: "https://images.example/episode-3.jpg",
    };
    save(database, profile.id, current, 960, 1_000);

    const items = await listContinueWatching(profile.id, database, {
      findNextEpisode: async (tmdbId, seasonNumber, episodeNumber) => {
        assert.deepEqual([tmdbId, seasonNumber, episodeNumber], [80, 1, 3]);
        return {
          season: 1,
          number: 4,
          title: "The Next Chapter",
          stillUrl: "https://images.example/episode-4.jpg",
        };
      },
    });

    assert.equal(items.length, 1);
    assert.deepEqual(
      {
        seasonNumber: items[0].seasonNumber,
        episodeNumber: items[0].episodeNumber,
        episodeTitle: items[0].episodeTitle,
        backdropUrl: items[0].backdropUrl,
        position: items[0].position,
        duration: items[0].duration,
        completed: items[0].completed,
      },
      {
        seasonNumber: 1,
        episodeNumber: 4,
        episodeTitle: "The Next Chapter",
        backdropUrl: "https://images.example/episode-4.jpg",
        position: 0,
        duration: 0,
        completed: false,
      },
    );
    assert.equal(getProgress(profile.id, episode(80, 1, 4), database), null);
  } finally {
    database.close();
  }
});

test("Continue Watching preserves progress already saved for the next episode", async () => {
  const database = createDatabase(":memory:");
  const originalNow = Date.now;
  try {
    const profile = createProfile({ name: "Viewer" }, database);
    let now = 3_000;
    Date.now = () => now;
    save(database, profile.id, episode(81, 1, 4), 240, 1_000);
    now += 1;
    save(database, profile.id, episode(81, 1, 3), 960, 1_000);

    const items = await listContinueWatching(profile.id, database, {
      findNextEpisode: async () => ({ season: 1, number: 4, title: "Episode 4" }),
    });

    assert.equal(items.length, 1);
    assert.equal(items[0].episodeNumber, 4);
    assert.equal(items[0].position, 240);
    assert.equal(items[0].duration, 1_000);
  } finally {
    Date.now = originalNow;
    database.close();
  }
});

test("Continue Watching crosses seasons, skips completed rows, and stops at series end", async () => {
  const database = createDatabase(":memory:");
  const originalNow = Date.now;
  try {
    const profile = createProfile({ name: "Viewer" }, database);
    let now = 4_000;
    Date.now = () => now;
    save(database, profile.id, episode(82, 1, 4), 960, 1_000);
    now += 1;
    save(database, profile.id, episode(82, 1, 3), 960, 1_000);

    const crossed = await listContinueWatching(profile.id, database, {
      findNextEpisode: async (_tmdbId, seasonNumber, episodeNumber) => {
        if (seasonNumber === 1 && episodeNumber === 3) {
          return { season: 1, number: 4, title: "Finale" };
        }
        return { season: 2, number: 1, title: "Premiere" };
      },
    });
    assert.deepEqual(
      crossed.map((item) => [item.seasonNumber, item.episodeNumber, item.position]),
      [[2, 1, 0]],
    );

    const ended = await listContinueWatching(profile.id, database, {
      findNextEpisode: async () => null,
    });
    assert.equal(ended.length, 0);
  } finally {
    Date.now = originalNow;
    database.close();
  }
});

test("a next-episode metadata failure does not hide other Continue Watching items", async () => {
  const database = createDatabase(":memory:");
  try {
    const profile = createProfile({ name: "Viewer" }, database);
    save(database, profile.id, episode(83, 1, 3), 960, 1_000);
    save(database, profile.id, movie(84, "Playable Movie"), 120, 1_000);

    const items = await listContinueWatching(profile.id, database, {
      findNextEpisode: async () => { throw new Error("TMDB unavailable"); },
    });
    assert.deepEqual(items.map((item) => item.title), ["Playable Movie"]);
  } finally {
    database.close();
  }
});

test("whole-title removal deletes every episode without affecting other titles", () => {
  const database = createDatabase(":memory:");
  try {
    const profile = createProfile({ name: "Viewer" }, database);
    save(database, profile.id, episode(90, 1, 1), 60, 1_000);
    save(database, profile.id, episode(90, 1, 2), 120, 1_000);
    save(database, profile.id, episode(91, 1, 1), 180, 1_000);

    assert.equal(removeTitleHistory(profile.id, { mediaType: "tv", tmdbId: 90 }, database), true);
    assert.equal(getProgress(profile.id, episode(90, 1, 1), database), null);
    assert.equal(getProgress(profile.id, episode(90, 1, 2), database), null);
    assert.equal(getProgress(profile.id, episode(91, 1, 1), database).position, 180);
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM progress_writers WHERE tmdb_id = 90").get().count,
      0,
    );
  } finally {
    database.close();
  }
});

test("progress validation clamps impossible positions and rejects invalid numbers", async () => {
  const database = createDatabase(":memory:");
  try {
    const profile = createProfile({ name: "Viewer" }, database);
    const media = movie(50);
    const writer = beginPlaybackSession(profile.id, media, database);
    assert.throws(() => saveProgress(profile.id, {
      writerToken: writer.writerToken,
      sequence: 1,
      position: Number.NaN,
      duration: 500,
    }, database), /finite positive/);
    saveProgress(profile.id, {
      writerToken: writer.writerToken,
      sequence: 2,
      position: 900,
      duration: 500,
    }, database);
    assert.equal(getProgress(profile.id, media, database).position, 500);
    assert.equal(removeHistory(profile.id, media, database), true);
    assert.equal((await listContinueWatching(profile.id, database)).length, 0);
  } finally {
    database.close();
  }
});
