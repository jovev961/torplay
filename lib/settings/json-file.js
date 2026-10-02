import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

export function readJsonFile(filename, fallback) {
  try { return JSON.parse(readFileSync(filename, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw Object.assign(new Error("Configuration could not be read."), { status: 500 });
  }
}

export async function writeJsonFile(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, filename);
  } finally { await unlink(temporary).catch(() => {}); }
}
