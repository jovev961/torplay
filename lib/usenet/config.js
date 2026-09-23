import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { settingsConfigPath } from "../settings/config.js";
import { serializeSettingsWrite } from "../settings/write-queue.js";

export function usenetConfigPath(environment = process.env, cwd = process.cwd()) {
  return path.join(path.dirname(settingsConfigPath(environment, cwd)), "usenet-config.json");
}

export async function readUsenetConfig(options = {}) {
  try {
    const value = JSON.parse(await readFile(/* turbopackIgnore: true */ options.path || usenetConfigPath(options.environment, options.cwd), "utf8"));
    return { enabled: value.enabled === true, indexers: Array.isArray(value.indexers) ? value.indexers : [] };
  } catch (error) {
    if (error.code === "ENOENT") return { enabled: false, indexers: [] };
    throw new Error("Usenet configuration could not be read.");
  }
}

export function publicUsenetConfig(config) {
  return {
    enabled: config.enabled,
    indexers: config.indexers.map(({ id, name, endpoint }) => ({ id, name, endpoint, configured: true })),
  };
}

export function validateIndexer(input) {
  const name = String(input?.name || "").trim();
  const apiKey = String(input?.apiKey || "").trim();
  let endpoint;
  try { endpoint = new URL(input?.endpoint); } catch { throw Object.assign(new Error("Enter a valid Newznab URL."), { status: 400 }); }
  if (!name || name.length > 80 || !apiKey || apiKey.length > 4096
    || endpoint.protocol !== "https:" || endpoint.username || endpoint.password
    || endpoint.search || endpoint.hash || !endpoint.hostname.includes(".")) {
    throw Object.assign(new Error("Enter a name, public HTTPS Newznab URL, and API key."), { status: 400 });
  }
  return { id: randomUUID(), name, endpoint: endpoint.href, apiKey };
}

export function updateUsenetConfig(updater, options = {}) {
  return serializeSettingsWrite(async () => {
    const next = await updater(await readUsenetConfig(options));
    const filename = options.path || usenetConfigPath(options.environment, options.cwd);
    await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(next), { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, filename);
      if (process.platform !== "win32") await chmod(filename, 0o600);
      return next;
    } catch {
      await unlink(temporary).catch(() => {});
      throw new Error("Usenet configuration could not be saved.");
    }
  });
}
