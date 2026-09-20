import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { testTorznab, torznabEndpoint } from "../search/torznab.js";
import { providerIds } from "../search/native/registry.js";
import { serializeSettingsWrite } from "./write-queue.js";

const health = new Map();
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
export function customProvidersPath(environment = process.env) {
  return path.join(path.dirname(path.resolve(/* turbopackIgnore: true */ environment.TORPLAY_CONFIG_PATH || ".env.local")), "torrent-providers.json");
}
export function readCustomProviders(environment = process.env) {
  try {
    const data = JSON.parse(readFileSync(customProvidersPath(environment), "utf8"));
    if (!Array.isArray(data) || data.some((item) => !item || typeof item.id !== "string"
      || !item.id.startsWith("custom-") || typeof item.name !== "string" || typeof item.endpoint !== "string"
      || typeof item.apiKey !== "string" || typeof item.enabled !== "boolean"
      || !Array.isArray(item.capabilities?.mediaTypes) || !item.capabilities?.modes)) throw new Error();
    return data;
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw fail("Custom provider configuration could not be read.", 500);
  }
}
export function effectiveCustomProviders(environment = process.env, providers = readCustomProviders(environment)) {
  const override = environment.TORPLAY_SEARCH_PROVIDERS;
  return providers.filter((item) => item.enabled && (override === undefined || providerIds(override).includes(item.id)));
}
export function publicCustomProviders(environment = process.env, canEdit = false) {
  const providers = readCustomProviders(environment);
  const active = effectiveCustomProviders(environment, providers);
  return providers.map(({ id, name, enabled, endpoint, apiKey, capabilities }) => ({
    id, name, enabled, type: "Torznab", mediaTypes: capabilities.mediaTypes,
    active: active.some((item) => item.id === id), apiKeyConfigured: Boolean(apiKey),
    ...(canEdit ? { endpoint } : {}),
  }));
}
function candidate(values, previous) {
  if (!values || typeof values !== "object") throw fail("Provider settings are required.");
  const name = String(values.name ?? previous?.name ?? "").trim();
  if (!name || name.length > 100 || /[\r\n\0]/.test(name)) throw fail("Enter a provider name up to 100 characters.");
  let endpoint;
  try { endpoint = torznabEndpoint(values.endpoint ?? previous?.endpoint); }
  catch (error) { throw fail(error.message); }
  const apiKey = values.clearApiKey ? "" : String(values.apiKey || previous?.apiKey || "").trim();
  if (apiKey.length > 4096 || /[\r\n\0]/.test(apiKey)) throw fail("Invalid API key.");
  if (values.enabled !== undefined && typeof values.enabled !== "boolean") throw fail("Enabled must be a boolean.");
  return { id: previous?.id || `custom-${randomUUID()}`, name, endpoint, apiKey, enabled: values.enabled ?? previous?.enabled ?? true };
}
export async function testCustomProvider(values, { environment = process.env, ...options } = {}) {
  const previous = values.id ? readCustomProviders(environment).find((item) => item.id === values.id) : null;
  if (values.id && !previous) throw fail("Provider not found.", 404);
  try { return await testTorznab(candidate(values, previous), options); }
  catch { throw fail("Connection test failed. Check the endpoint, API key, and movie/TV capabilities.", 422); }
}
export function changeCustomProvider(action, values, { environment = process.env, ...options } = {}) {
  return serializeSettingsWrite(async () => {
    const providers = readCustomProviders(environment);
    if (action === "create" && providers.length >= 20) throw fail("A maximum of 20 custom providers is supported.");
    const previous = providers.find((item) => item.id === values.id);
    if (action === "create" && values.id) throw fail("New providers must not include an ID.");
    if (action !== "create" && !previous) throw fail("Provider not found.", 404);
    let next = providers.filter((item) => item.id !== previous?.id);
    if (action !== "remove") {
      const item = candidate(values, previous);
      if (providers.some((other) => other.id !== item.id && other.endpoint === item.endpoint)) throw fail("This endpoint is already configured.");
      const connectionChanged = !previous || previous.endpoint !== item.endpoint || previous.apiKey !== item.apiKey;
      try { item.capabilities = connectionChanged ? await testTorznab(item, options) : previous.capabilities; }
      catch { throw fail("Connection test failed. Provider settings were not saved.", 422); }
      next.push(item);
    }
    const filename = customProvidersPath(environment);
    await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(next, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      await rename(temporary, filename);
    } finally { await unlink(temporary).catch(() => {}); }
    health.clear();
    return publicCustomProviders(environment, true);
  });
}
export async function customProviderHealth({ environment = process.env, refresh = false, ...options } = {}) {
  const providers = readCustomProviders(environment);
  const active = effectiveCustomProviders(environment, providers);
  return Promise.all(providers.map(async (provider) => {
    if (!active.some((item) => item.id === provider.id)) return { provider: provider.id, status: "disabled", message: "Source is disabled or excluded by the provider override." };
    const key = JSON.stringify(provider);
    const cached = health.get(key);
    if (!refresh && cached?.expires > Date.now()) return cached.result;
    let status = "connected";
    try { await testTorznab(provider, options); } catch { status = "unavailable"; }
    const result = { provider: provider.id, status, message: status === "connected" ? "Connection verified." : "Source could not be verified.", checkedAt: new Date().toISOString() };
    health.set(key, { result, expires: Date.now() + 60_000 });
    return result;
  }));
}
