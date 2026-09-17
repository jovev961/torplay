import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { subtitleConfig } from "./config.js";

function stableNumber(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${label} is invalid.`);
  return String(parsed);
}

function stableToken(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function cacheRoot() {
  return path.resolve(/* turbopackIgnore: true */ process.cwd(), subtitleConfig().cachePath);
}

export function subtitleCachePath(context, provider, subtitleId) {
  const tmdbId = stableNumber(context.tmdbId, "TMDB ID");
  const mediaParts = context.type === "show"
    ? ["shows", tmdbId, `s${stableNumber(context.season, "Season")}`, `e${stableNumber(context.episode, "Episode")}`]
    : ["movies", tmdbId];
  const safeProvider = /^[a-z][a-z\d-]{1,30}$/i.test(provider) ? provider.toLowerCase() : "unknown";
  return path.join(cacheRoot(), ...mediaParts, safeProvider, `${stableToken(subtitleId)}.vtt`);
}

export async function readCachedSubtitle(context, provider, subtitleId) {
  try {
    return await readFile(subtitleCachePath(context, provider, subtitleId), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function writeCachedSubtitle(context, provider, subtitleId, body) {
  const destination = subtitleCachePath(context, provider, subtitleId);
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  await writeFile(temporary, body, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, destination);
  return destination;
}

export function subtitleContentHash(body) {
  return createHash("sha256").update(body).digest("hex");
}
