import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { stringify } from "yaml";
import { testTorznab, torznabEndpoint } from "../search/torznab.js";
import { cardigannAdapter, classifyCardigannVerificationFailure, testCardigannProvider } from "../search/cardigann/engine.js";
import {
  confirmedVerificationFailure,
  consumeImportedDefinition,
  importedDefinition,
  parseDefinition,
  rememberVerificationFailure,
  settingDescriptors,
  validateDefinitionObject,
  validateDefinitionSettings,
} from "../search/cardigann/definition.js";
import { providerIds } from "../search/provider-config.js";
import { serializeSettingsWrite } from "./write-queue.js";

const health = new Map();
const fail = (message, status = 400, details = {}) => Object.assign(new Error(message), { status, ...details });

function verificationRecord(status, diagnostic, now = Date.now()) {
  return {
    status,
    ...(diagnostic ? { code: diagnostic.code, message: diagnostic.message } : { message: "Connection verified." }),
    checkedAt: new Date(typeof now === "function" ? now() : now).toISOString(),
  };
}

function storedVerification(value) {
  if (value?.status === "unverified" && typeof value.message === "string") {
    return {
      status: "unverified",
      code: typeof value.code === "string" ? value.code : "CARDIGANN_VERIFICATION_FAILED",
      message: value.message.slice(0, 300),
      checkedAt: typeof value.checkedAt === "string" ? value.checkedAt : null,
    };
  }
  return {
    status: "verified",
    message: "Connection was verified when this indexer was added.",
    checkedAt: typeof value?.checkedAt === "string" ? value.checkedAt : null,
  };
}
export function customProvidersPath(environment = process.env) {
  return path.join(path.dirname(path.resolve(/* turbopackIgnore: true */ environment.TORPLAY_CONFIG_PATH || ".env.local")), "torrent-providers.json");
}
export function readCustomProviders(environment = process.env) {
  try {
    const data = JSON.parse(readFileSync(customProvidersPath(environment), "utf8"));
    if (!Array.isArray(data)) throw new Error();
    return data.map((item) => {
      if (!item || typeof item.id !== "string" || typeof item.name !== "string" || typeof item.enabled !== "boolean"
        || !Array.isArray(item.capabilities?.mediaTypes) || !item.capabilities?.modes) throw new Error();
      if ((item.kind || "torznab") === "torznab") {
        if (!item.id.startsWith("custom-") || typeof item.endpoint !== "string" || typeof item.apiKey !== "string") throw new Error();
        return item;
      }
      if (item.kind !== "cardigann" || !item.id.startsWith("cardigann-") || typeof item.definitionUrl !== "string"
        || typeof item.definitionHash !== "string" || typeof item.settings !== "object") throw new Error();
      if (typeof item.definitionYaml === "string") {
        const hash = createHash("sha256").update(Buffer.from(item.definitionYaml)).digest("hex");
        if (hash !== item.definitionHash) throw new Error();
        const parsed = parseDefinition(item.definitionYaml);
        return { ...item, definition: parsed.definition, capabilities: parsed.capabilities, verification: storedVerification(item.verification) };
      }
      if (!item.definition) throw new Error();
      const parsed = validateDefinitionObject(item.definition);
      return { ...item, definition: parsed.definition, capabilities: parsed.capabilities, verification: storedVerification(item.verification) };
    });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw fail("Custom provider configuration could not be read.", 500);
  }
}

function persistedProviders(providers) {
  return providers.map((provider) => {
    if (provider.kind !== "cardigann" || typeof provider.definitionYaml === "string") return provider;
    const definitionYaml = stringify(provider.definition);
    return {
      ...provider,
      definitionYaml,
      definitionHash: createHash("sha256").update(Buffer.from(definitionYaml)).digest("hex"),
      definitionSourceFormat: "canonicalized-legacy",
    };
  });
}
export function effectiveCustomProviders(environment = process.env, providers = readCustomProviders(environment)) {
  const override = environment.TORPLAY_SEARCH_PROVIDERS;
  return providers.filter((item) => item.enabled && (override === undefined || providerIds(override).includes(item.id)));
}
export function publicCustomProviders(environment = process.env, canEdit = false) {
  const providers = readCustomProviders(environment);
  const active = effectiveCustomProviders(environment, providers);
  return providers.map((provider) => {
    const { id, name, enabled, capabilities } = provider;
    if (provider.kind === "cardigann") return {
      id, name, enabled, kind: "cardigann", type: "Cardigann", mediaTypes: capabilities.mediaTypes,
      active: active.some((item) => item.id === id), definitionUrl: provider.definitionUrl,
      definitionId: provider.definition.id,
      categories: capabilities.categories,
      verification: provider.verification,
      ...(canEdit ? { settings: settingDescriptors(provider.definition, provider.settings) } : {}),
    };
    return {
      id, name, enabled, kind: "torznab", type: "Torznab", mediaTypes: capabilities.mediaTypes,
      active: active.some((item) => item.id === id), apiKeyConfigured: Boolean(provider.apiKey),
      ...(canEdit ? { endpoint: provider.endpoint } : {}),
    };
  });
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
  if (previous?.kind === "cardigann") throw fail("Cardigann providers use their definition settings.", 400);
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
    if (previous?.kind === "cardigann") throw fail("Cardigann providers use their definition settings.", 400);
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
      await writeFile(temporary, JSON.stringify(persistedProviders(next), null, 2) + "\n", { mode: 0o600, flag: "wx" });
      await rename(temporary, filename);
    } finally { await unlink(temporary).catch(() => {}); }
    health.clear();
    return publicCustomProviders(environment, true);
  });
}

function saveProviders(providers, environment) {
  return (async () => {
    const filename = customProvidersPath(environment);
    await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(persistedProviders(providers), null, 2) + "\n", { mode: 0o600, flag: "wx" });
      await rename(temporary, filename);
    } finally { await unlink(temporary).catch(() => {}); }
    health.clear();
    return publicCustomProviders(environment, true);
  })();
}

export function createCardigannProvider(values, { environment = process.env, ...options } = {}) {
  return serializeSettingsWrite(async () => {
    const providers = readCustomProviders(environment);
    if (providers.length >= 20) throw fail("A maximum of 20 custom providers is supported.");
    const imported = importedDefinition(values.importId);
    if (providers.some((item) => item.kind === "cardigann" && item.definition.id === imported.definition.id)) {
      throw fail("This Cardigann definition is already configured.");
    }
    const settings = validateDefinitionSettings(imported.definition, values.settings || {});
    const hasSecrets = settingDescriptors(imported.definition, settings).some((item) => item.secret && item.configured);
    if (hasSecrets && imported.definition.links.some((link) => new URL(link).protocol !== "https:")) {
      throw fail("Private indexers must use HTTPS before TorPlay can send credentials.");
    }
    const provider = {
      id: `cardigann-${randomUUID()}`,
      kind: "cardigann",
      name: imported.definition.name,
      definitionUrl: imported.sourceUrl,
      definitionHash: imported.hash,
      definitionYaml: imported.definitionYaml,
      definitionSourceFormat: "original",
      definition: imported.definition,
      settings,
      enabled: values.enabled !== false,
      capabilities: imported.capabilities,
    };
    if (values.addUnverified === true) {
      const diagnostic = confirmedVerificationFailure(imported.id, settings, values.confirmationToken);
      provider.verification = verificationRecord("unverified", diagnostic, options.now);
    } else {
      try {
        await testCardigannProvider(provider, options);
        provider.verification = verificationRecord("verified", null, options.now);
      } catch (error) {
        const diagnostic = classifyCardigannVerificationFailure(error);
        const confirmationToken = rememberVerificationFailure(imported.id, settings, diagnostic);
        throw fail("Could not verify the indexer connection.", 422, {
          code: "CARDIGANN_VERIFICATION_FAILED",
          canAddUnverified: true,
          confirmationToken,
          verificationFailure: diagnostic,
        });
      }
    }
    const result = await saveProviders([...providers, provider], environment);
    consumeImportedDefinition(imported.id);
    return result;
  });
}

export function updateCardigannProvider(values, { environment = process.env, ...options } = {}) {
  return serializeSettingsWrite(async () => {
    const providers = readCustomProviders(environment);
    const previous = providers.find((item) => item.id === values.id && item.kind === "cardigann");
    if (!previous) throw fail("Provider not found.", 404);
    const settings = values.settings === undefined
      ? previous.settings
      : validateDefinitionSettings(previous.definition, values.settings, previous.settings);
    if (values.enabled !== undefined && typeof values.enabled !== "boolean") throw fail("Enabled must be a boolean.");
    const next = { ...previous, settings, enabled: values.enabled ?? previous.enabled };
    if (values.settings !== undefined) {
      try {
        await testCardigannProvider(next, options);
        next.verification = verificationRecord("verified", null, options.now);
      } catch (error) {
        const diagnostic = classifyCardigannVerificationFailure(error);
        throw fail(`Could not verify the indexer connection. ${diagnostic.message} Provider settings were not saved.`, 422, {
          code: diagnostic.code,
          verificationFailure: diagnostic,
        });
      }
    }
    return saveProviders(providers.map((item) => item.id === next.id ? next : item), environment);
  });
}

export function testCardigannProviderConnection(values, { environment = process.env, ...options } = {}) {
  return serializeSettingsWrite(async () => {
    const providers = readCustomProviders(environment);
    const previous = providers.find((item) => item.id === values.id && item.kind === "cardigann");
    if (!previous) throw fail("Provider not found.", 404);
    let verification;
    try {
      await testCardigannProvider(previous, options);
      verification = verificationRecord("verified", null, options.now);
    } catch (error) {
      verification = verificationRecord("unverified", classifyCardigannVerificationFailure(error), options.now);
    }
    const next = { ...previous, verification };
    const result = await saveProviders(providers.map((item) => item.id === next.id ? next : item), environment);
    return { providers: result, verification };
  });
}

export function removeCardigannProvider(values, { environment = process.env } = {}) {
  return serializeSettingsWrite(async () => {
    const providers = readCustomProviders(environment);
    const previous = providers.find((item) => item.id === values.id && item.kind === "cardigann");
    if (!previous) throw fail("Provider not found.", 404);
    return saveProviders(providers.filter((item) => item.id !== previous.id), environment);
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
    let diagnostic;
    try {
      if (provider.kind === "cardigann") await testCardigannProvider(provider, options);
      else await testTorznab(provider, options);
    } catch (error) {
      status = "unavailable";
      if (provider.kind === "cardigann") diagnostic = classifyCardigannVerificationFailure(error);
    }
    const result = {
      provider: provider.id,
      status,
      message: status === "connected" ? "Connection verified." : diagnostic?.message || "Source could not be verified.",
      checkedAt: new Date().toISOString(),
    };
    health.set(key, { result, expires: Date.now() + 60_000 });
    return result;
  }));
}

export function customProviderAdapter(provider, options = {}) {
  return provider.kind === "cardigann" ? cardigannAdapter(provider, options) : null;
}
