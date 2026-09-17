import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDatabase } from "../lib/database/sqlite.js";
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

test("profiles keep stable IDs through rename and delete their history", () => {
  const database = createDatabase(":memory:");
  try {
    const profile = createProfile({ name: " Vasil " }, database);
    const renamed = renameProfile(profile.id, { name: "Viewer" }, database);
    assert.equal(renamed.id, profile.id);
    assert.equal(renamed.name, "Viewer");
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

test("opening a player creates a zero-position Continue Watching entry", () => {
  const database = createDatabase(":memory:");
  try {
    const profile = createProfile({ name: "Viewer" }, database);
    const media = episode(31, 1, 3);
    const started = beginPlaybackSession(profile.id, media, database);

    assert.equal(started.progress.position, 0);
    assert.equal(started.progress.duration, 0);
    assert.equal(started.progress.completed, false);
    assert.deepEqual(listContinueWatching(profile.id, database).map((item) => item.episodeNumber), [3]);

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
    assert.equal(database.pragma("user_version", { simple: true }), 2);
  } finally {
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

test("Continue Watching applies centralized thresholds and recent ordering", () => {
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
      listContinueWatching(profile.id, database).map((item) => item.title),
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

test("history groups TV episodes by title while preserving episode progress", () => {
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
    assert.equal(listContinueWatching(profile.id, database).filter((item) => item.tmdbId === 77).length, 1);

    now += 1;
    save(database, profile.id, episode(77, 1, 5), 960, 1_000);
    assert.equal(listContinueWatching(profile.id, database).some((item) => item.tmdbId === 77), false);
    assert.equal(getProgress(profile.id, episode(77, 1, 1), database).position, 60);
  } finally {
    Date.now = originalNow;
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

test("progress validation clamps impossible positions and rejects invalid numbers", () => {
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
    assert.equal(listContinueWatching(profile.id, database).length, 0);
  } finally {
    database.close();
  }
});
