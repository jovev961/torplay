import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  cleanupSubtitleCache,
  readCachedSubtitle,
  SUBTITLE_CACHE_TEMP_TTL_MS,
  subtitleCachePath,
  writeCachedSubtitle,
} from "../lib/subtitles/cache.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function config(root, cacheTtlDays = 30) {
  return { cachePath: root, cacheTtlDays };
}

async function temporaryCache(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "torplay-subtitle-cache-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const movie = { type: "movie", tmdbId: 10 };
const episode = { type: "show", tmdbId: 20, season: 1, episode: 2 };

test("cached subtitle reads refresh last-use time and cleaned entries can be cached again", async () => {
  await temporaryCache(async (root) => {
    const cacheConfig = config(root);
    const filename = await writeCachedSubtitle(movie, "subdl", "subtitle-1", "WEBVTT\n", {
      config: cacheConfig,
    });
    const old = Date.now() - 40 * DAY_MS;
    await utimes(filename, new Date(old), new Date(old));

    const usedAt = Date.now();
    assert.equal(await readCachedSubtitle(movie, "subdl", "subtitle-1", {
      config: cacheConfig,
      now: usedAt,
    }), "WEBVTT\n");
    assert.ok(Math.abs((await stat(filename)).mtimeMs - usedAt) < 2_000);

    await utimes(filename, new Date(old), new Date(old));
    const result = await cleanupSubtitleCache({ config: cacheConfig, now: usedAt });
    assert.equal(result.removedFiles, 1);
    assert.equal(await readCachedSubtitle(movie, "subdl", "subtitle-1", { config: cacheConfig }), null);

    await writeCachedSubtitle(movie, "subdl", "subtitle-1", "WEBVTT\nrefetched\n", {
      config: cacheConfig,
    });
    assert.equal(
      await readCachedSubtitle(movie, "subdl", "subtitle-1", { config: cacheConfig }),
      "WEBVTT\nrefetched\n",
    );
  });
});

test("cleanup removes expired movie, show, and temporary files while preserving active and unexpected files", async () => {
  await temporaryCache(async (root) => {
    const cacheConfig = config(root);
    const now = Date.now();
    const old = new Date(now - 31 * DAY_MS);
    const movieFile = await writeCachedSubtitle(movie, "subdl", "old-movie", "WEBVTT\n", {
      config: cacheConfig,
    });
    const showFile = await writeCachedSubtitle(episode, "opensubtitles", "old-show", "WEBVTT\n", {
      config: cacheConfig,
    });
    const activeFile = await writeCachedSubtitle(episode, "subdl", "active-show", "WEBVTT\n", {
      config: cacheConfig,
    });
    await Promise.all([movieFile, showFile, activeFile].map((filename) => utimes(filename, old, old)));

    const temporary = `${showFile}.12345678-1234-1234-1234-123456789abc.tmp`;
    await writeFile(temporary, "partial");
    const tempOld = new Date(now - SUBTITLE_CACHE_TEMP_TTL_MS - 1_000);
    await utimes(temporary, tempOld, tempOld);
    const unexpected = path.join(path.dirname(showFile), "notes.txt");
    await writeFile(unexpected, "keep me");
    const linked = path.join(path.dirname(showFile), "linked.vtt");
    await symlink(activeFile, linked);

    const result = await cleanupSubtitleCache({
      config: cacheConfig,
      now,
      isProtected: (filename) => filename === activeFile,
    });

    assert.equal(result.removedFiles, 3);
    await assert.rejects(access(movieFile));
    await assert.rejects(access(showFile));
    await assert.rejects(access(temporary));
    await access(activeFile);
    await access(unexpected);
    await access(linked);
  });
});

test("cleanup isolates file deletion failures and leaves the failed entry available", async () => {
  await temporaryCache(async (root) => {
    const cacheConfig = config(root);
    const filename = await writeCachedSubtitle(movie, "subdl", "undeletable", "WEBVTT\n", {
      config: cacheConfig,
    });
    const now = Date.now();
    const old = new Date(now - 31 * DAY_MS);
    await utimes(filename, old, old);

    const result = await cleanupSubtitleCache({
      config: cacheConfig,
      now,
      removeFile: async () => { throw new Error("permission denied"); },
    });
    assert.equal(result.removedFiles, 0);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0].message, /permission denied/);
    await access(filename);
  });
});

test("cleanup ignores unmanaged directories and files", async () => {
  await temporaryCache(async (root) => {
    const cacheConfig = config(root);
    const unmanaged = path.join(root, "movies", "not-a-tmdb-id", "provider", `${"a".repeat(64)}.vtt`);
    await mkdir(path.dirname(unmanaged), { recursive: true });
    await writeFile(unmanaged, "do not remove");
    await writeFile(path.join(root, "keep.txt"), "root file");

    const result = await cleanupSubtitleCache({ config: cacheConfig, now: Date.now() });
    assert.deepEqual(result, { removedFiles: 0, removedDirectories: 0, failures: [] });
    await access(unmanaged);
    await access(path.join(root, "keep.txt"));
  });
});

test("subtitle cache paths remain stable for movies and TV episodes", () => {
  const cacheConfig = config("/tmp/subtitle-cache-root");
  assert.match(
    subtitleCachePath(movie, "SubDL", "same-id", cacheConfig).replaceAll("\\", "/"),
    /subtitle-cache-root\/movies\/10\/subdl\/[a-f\d]{64}\.vtt$/,
  );
  assert.match(
    subtitleCachePath(episode, "OpenSubtitles", "same-id", cacheConfig).replaceAll("\\", "/"),
    /subtitle-cache-root\/shows\/20\/s1\/e2\/opensubtitles\/[a-f\d]{64}\.vtt$/,
  );
});
