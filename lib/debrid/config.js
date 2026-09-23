import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { settingsConfigPath } from "../settings/config.js";
import { serializeSettingsWrite } from "../settings/write-queue.js";

export const DEBRID_PROVIDERS = ["real-debrid", "torbox"];
export const DEBRID_MODES = ["local", "prefer-debrid", "debrid-only"];
const defaults = {
  mode: "local",
  priority: ["real-debrid", "torbox"],
  localFallback: true,
  credentials: {},
};

export function debridConfigPath(environment = process.env, cwd = process.cwd()) {
  return path.join(path.dirname(settingsConfigPath(environment, cwd)), "debrid-config.json");
}

export async function readDebridConfig(options = {}) {
  try {
    const raw = JSON.parse(await readFile(/* turbopackIgnore: true */ options.path || debridConfigPath(options.environment, options.cwd), "utf8"));
    return {
      mode: DEBRID_MODES.includes(raw.mode) ? raw.mode : defaults.mode,
      priority: validPriority(raw.priority) ? raw.priority : [...defaults.priority],
      localFallback: raw.localFallback !== false,
      credentials: raw.credentials && typeof raw.credentials === "object" && !Array.isArray(raw.credentials)
        ? raw.credentials : {},
    };
  } catch (error) {
    if (error.code === "ENOENT") return { ...defaults, priority: [...defaults.priority], credentials: {} };
    throw new Error("Debrid configuration could not be read.");
  }
}

function validPriority(value) {
  return Array.isArray(value) && value.length === 2
    && value.every((id) => DEBRID_PROVIDERS.includes(id))
    && new Set(value).size === 2;
}

async function saveConfig(config, options = {}) {
  const filename = options.path || debridConfigPath(options.environment, options.cwd);
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(config), { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, filename);
    if (process.platform !== "win32") await chmod(filename, 0o600);
  } catch {
    await unlink(temporary).catch(() => {});
    throw new Error("Debrid configuration could not be saved.");
  }
}

export function updateDebridConfig(updater, options = {}) {
  return serializeSettingsWrite(async () => {
    const current = await readDebridConfig(options);
    const next = await updater(current);
    await saveConfig(next, options);
    return next;
  });
}

export function updateDebridPolicy(input, options = {}) {
  if (!DEBRID_MODES.includes(input?.mode) || !validPriority(input?.priority)
    || typeof input?.localFallback !== "boolean") {
    throw Object.assign(new Error("Invalid debrid playback settings."), { status: 400 });
  }
  return updateDebridConfig((current) => ({
    ...current,
    mode: input.mode,
    priority: input.priority,
    localFallback: input.localFallback,
  }), options);
}

export function publicDebridConfig(config) {
  return {
    mode: config.mode,
    priority: config.priority,
    localFallback: config.localFallback,
    providers: Object.fromEntries(DEBRID_PROVIDERS.map((id) => [id, {
      configured: Boolean(config.credentials[id]),
    }])),
  };
}
