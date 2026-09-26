import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { providerIds } from "../search/provider-config.js";
import { TESTED_SOURCES, testedSource } from "../search/native/registry.js";
import { serializeSettingsWrite } from "./write-queue.js";

const health = new Map();
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

export function nativeSourcesPath(environment = process.env) {
  const config = path.resolve(/* turbopackIgnore: true */ environment.TORPLAY_CONFIG_PATH?.trim() || ".env.local");
  return path.join(path.dirname(config), "native-sources.json");
}

export function readNativeSources(environment = process.env) {
  try {
    const data = JSON.parse(readFileSync(nativeSourcesPath(environment), "utf8"));
    if (!Array.isArray(data)) throw new Error();
    const ids = new Set();
    return data.map((item) => {
      if (!item || typeof item.id !== "string" || typeof item.enabled !== "boolean"
        || !testedSource(item.id) || ids.has(item.id)) throw new Error();
      ids.add(item.id);
      return { id: item.id, enabled: item.enabled };
    });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw fail("Native source configuration could not be read.", 500);
  }
}

export function effectiveNativeSources(environment = process.env, saved = readNativeSources(environment)) {
  const override = environment.TORPLAY_SEARCH_PROVIDERS;
  const allowed = override === undefined ? null : new Set(providerIds(override));
  return saved.filter((item) => item.enabled && (!allowed || allowed.has(item.id)))
    .map((item) => testedSource(item.id));
}

export function publicNativeSources(environment = process.env) {
  const saved = readNativeSources(environment);
  const active = new Set(effectiveNativeSources(environment, saved).map((item) => item.id));
  return TESTED_SOURCES.map(({ id, name, description, mediaTypes }) => {
    const configured = saved.find((item) => item.id === id);
    return {
      id,
      name,
      description,
      mediaTypes,
      configured: Boolean(configured),
      enabled: configured?.enabled === true,
      active: active.has(id),
    };
  });
}

async function saveNativeSources(sources, environment) {
  const filename = nativeSourcesPath(environment);
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(sources, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, filename);
  } finally {
    await unlink(temporary).catch(() => {});
  }
  health.clear();
  return publicNativeSources(environment);
}

export function changeNativeSource(action, values, { environment = process.env } = {}) {
  return serializeSettingsWrite(async () => {
    const source = testedSource(values?.id);
    if (!source) throw fail("Unknown TorPlay tested source.");
    const saved = readNativeSources(environment);
    const previous = saved.find((item) => item.id === source.id);
    if (action === "add") {
      if (previous) throw fail("This source is already configured.", 409);
      return saveNativeSources([...saved, { id: source.id, enabled: true }], environment);
    }
    if (!previous) throw fail("Source not found.", 404);
    if (action === "remove") return saveNativeSources(saved.filter((item) => item.id !== source.id), environment);
    if (action !== "update" || typeof values.enabled !== "boolean") throw fail("Enabled must be a boolean.");
    return saveNativeSources(saved.map((item) => item.id === source.id
      ? { ...item, enabled: values.enabled }
      : item), environment);
  });
}

async function probe(source, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    await source.probe({ signal: controller.signal, fetchImpl: options.fetchImpl });
    return { provider: source.id, status: "connected", message: "Source is available.", checkedAt: new Date().toISOString() };
  } catch {
    options.signal?.throwIfAborted();
    return { provider: source.id, status: "unavailable", message: "Source could not be verified.", checkedAt: new Date().toISOString() };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}

export async function nativeSourceHealth({ environment = process.env, refresh = false, ...options } = {}) {
  const saved = readNativeSources(environment);
  const active = new Set(effectiveNativeSources(environment, saved).map((item) => item.id));
  return Promise.all(saved.map(async (item) => {
    if (!item.enabled || !active.has(item.id)) {
      const result = { provider: item.id, status: "disabled", message: !item.enabled
        ? "Source is disabled." : "Source is excluded by the provider override." };
      options.onResult?.(result);
      return result;
    }
    const source = testedSource(item.id);
    const cached = health.get(item.id);
    if (cached) options.onCached?.(cached.result, refresh || cached.expires <= Date.now());
    if (!refresh && cached?.expires > Date.now()) return cached.result;
    const result = await probe(source, options);
    health.set(item.id, { result, expires: Date.now() + 60_000 });
    options.onResult?.(result);
    return result;
  }));
}
