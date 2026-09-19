import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { subtitleConfig } from "./config.js";

const DAY_MS = 24 * 60 * 60 * 1000;
export const SUBTITLE_CACHE_TEMP_TTL_MS = 60 * 60 * 1000;
const CACHE_FILE_PATTERN = /^[a-f\d]{64}\.vtt$/i;
const TEMP_FILE_PATTERN = /^[a-f\d]{64}\.vtt\.[a-f\d-]{36}\.tmp$/i;
const PROVIDER_PATTERN = /^[a-z][a-z\d-]{1,30}$/i;

function stableNumber(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${label} is invalid.`);
  return String(parsed);
}

function stableToken(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function cacheRoot(config = subtitleConfig()) {
  return path.resolve(/* turbopackIgnore: true */ process.cwd(), config.cachePath);
}

export function subtitleCachePath(context, provider, subtitleId, config = subtitleConfig()) {
  const tmdbId = stableNumber(context.tmdbId, "TMDB ID");
  const mediaParts = context.type === "show"
    ? ["shows", tmdbId, `s${stableNumber(context.season, "Season")}`, `e${stableNumber(context.episode, "Episode")}`]
    : ["movies", tmdbId];
  const safeProvider = /^[a-z][a-z\d-]{1,30}$/i.test(provider) ? provider.toLowerCase() : "unknown";
  return path.join(cacheRoot(config), ...mediaParts, safeProvider, `${stableToken(subtitleId)}.vtt`);
}

export async function readCachedSubtitle(context, provider, subtitleId, options = {}) {
  const filename = subtitleCachePath(context, provider, subtitleId, options.config);
  try {
    const body = await readFile(filename, "utf8");
    const usedAt = new Date(options.now ?? Date.now());
    await utimes(filename, usedAt, usedAt).catch(() => {});
    return body;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function writeCachedSubtitle(context, provider, subtitleId, body, options = {}) {
  const destination = subtitleCachePath(context, provider, subtitleId, options.config);
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, body, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return destination;
}

function managedDirectory(parts) {
  if (parts[0] === "movies") {
    return parts.length <= 3
      && (parts.length < 2 || /^\d+$/.test(parts[1]))
      && (parts.length < 3 || PROVIDER_PATTERN.test(parts[2]));
  }
  if (parts[0] === "shows") {
    return parts.length <= 5
      && (parts.length < 2 || /^\d+$/.test(parts[1]))
      && (parts.length < 3 || /^s\d+$/.test(parts[2]))
      && (parts.length < 4 || /^e\d+$/.test(parts[3]))
      && (parts.length < 5 || PROVIDER_PATTERN.test(parts[4]));
  }
  return false;
}

function managedFile(parts, name) {
  const expectedDepth = parts[0] === "movies" ? 3 : parts[0] === "shows" ? 5 : -1;
  return parts.length === expectedDepth
    && (CACHE_FILE_PATTERN.test(name) || TEMP_FILE_PATTERN.test(name));
}

export async function cleanupSubtitleCache(options = {}) {
  const config = options.config || subtitleConfig();
  const root = cacheRoot(config);
  const now = options.now ?? Date.now();
  const subtitleCutoff = now - config.cacheTtlDays * DAY_MS;
  const temporaryCutoff = now - SUBTITLE_CACHE_TEMP_TTL_MS;
  const isProtected = options.isProtected || (() => false);
  const removeFile = options.removeFile || ((filename) => rm(filename, { force: true }));
  const removeDirectory = options.removeDirectory || ((directory) => rmdir(directory));
  const result = { removedFiles: 0, removedDirectories: 0, failures: [] };

  async function entries(directory) {
    try {
      return await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return null;
      result.failures.push({ path: directory, message: error.message });
      return null;
    }
  }

  async function cleanDirectory(directory, parts) {
    const children = await entries(directory);
    if (!children) return;

    for (const child of children) {
      const filename = path.join(directory, child.name);
      if (child.isSymbolicLink()) continue;
      if (child.isDirectory()) {
        const nextParts = [...parts, child.name];
        if (managedDirectory(nextParts)) await cleanDirectory(filename, nextParts);
        continue;
      }
      if (!child.isFile() || !managedFile(parts, child.name)) continue;

      try {
        const details = await stat(filename);
        const cutoff = TEMP_FILE_PATTERN.test(child.name) ? temporaryCutoff : subtitleCutoff;
        if (details.mtimeMs >= cutoff || isProtected(path.resolve(filename))) continue;
        await removeFile(filename);
        result.removedFiles += 1;
      } catch (error) {
        if (error.code !== "ENOENT") {
          result.failures.push({ path: filename, message: error.message });
        }
      }
    }

    const remaining = await entries(directory);
    if (remaining?.length === 0) {
      try {
        await removeDirectory(directory);
        result.removedDirectories += 1;
      } catch (error) {
        if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") {
          result.failures.push({ path: directory, message: error.message });
        }
      }
    }
  }

  for (const branch of ["movies", "shows"]) {
    await cleanDirectory(path.join(/* turbopackIgnore: true */ root, branch), [branch]);
  }
  return result;
}

export function subtitleContentHash(body) {
  return createHash("sha256").update(body).digest("hex");
}
