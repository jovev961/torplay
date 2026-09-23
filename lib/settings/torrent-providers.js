import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, writeFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { stringify } from "yaml";
import { testTorznab, torznabEndpoint } from "../search/torznab.js";
import { configuredJackett, jackettEndpoint, jackettProvider, listJackettIndexers } from "../search/jackett-service.js";
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
function migrateLegacyJackett(providers, environment) {
  const key = String(environment.JACKETT_API_KEY || "").trim();
  const base = String(environment.JACKETT_URL || "").trim();
  if (!key || key === "replace-me" || !base) return providers;
  try { jackettEndpoint(base); }
  catch { throw fail("Legacy Jackett settings have an invalid URL. No source was converted.", 500); }
  const ids = (value) => [...new Set(String(value || "").split(",").map((item) => item.trim()).filter(Boolean))];
  const movie = ids(environment.JACKETT_MOVIE_INDEXERS);
  const show = ids(environment.JACKETT_SHOW_INDEXERS);
  if (!movie.length && !show.length) return providers;
  const valid = (value) => /^[a-z\d][a-z\d._-]{0,99}$/i.test(value);
  if ([...movie, ...show].some((id) => !valid(id))) throw fail("Legacy Jackett settings contain an invalid indexer ID. No source was converted.", 500);
  const generic = movie.length || show.length ? new Set([...movie, ...show]) : new Set(["all"]);
  const allIds = [...new Set([...(movie.length ? movie : ["all"]), ...(show.length ? show : ["all"]), ...generic])];
  const converted = allIds.map((id) => {
    const endpoint = jackettEndpoint(base, id);
    const searchMediaTypes = [
      ...(movie.includes(id) || (!movie.length && id === "all") ? ["Movies"] : []),
      ...(show.includes(id) || (!show.length && id === "all") ? ["TV"] : []),
    ];
    return {
      id: `custom-${createHash("sha256").update(`legacy-jackett:${endpoint}`).digest("hex").slice(0, 24)}`,
      kind: "jackett", name: id === "all" ? "Jackett (all)" : `Jackett (${id})`, indexerId: id,
      enabled: true, searchMediaTypes, genericEnabled: generic.has(id),
      capabilities: { mediaTypes: searchMediaTypes.length ? searchMediaTypes : ["Movies", "TV"],
        modes: { search: ["q"], movie: ["q"], tvsearch: ["q", "season", "ep"] }, limit: 50 },
    };
  });
  const missing = converted.filter((item) => !providers.some((existing) => existing.id === item.id || existing.endpoint === jackettEndpoint(base, item.indexerId)));
  if (providers.length + missing.length > 20) throw fail("Legacy Jackett settings exceed the source limit. No source was converted.", 500);
  return [...providers, ...missing];
}
function writeStoreSync(store, environment) {
  const filename = customProvidersPath(environment);
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    writeFileSync(temporary, JSON.stringify(store, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(temporary, filename);
  } finally { try { unlinkSync(temporary); } catch { /* Rename removed it. */ } }
}
function readProviderStore(environment = process.env) {
  try {
    let data;
    let exists = true;
    try { data = JSON.parse(readFileSync(customProvidersPath(environment), "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; data = []; exists = false; }
    const legacyFormat = Array.isArray(data);
    if (!legacyFormat && (data?.version !== 2 || !Array.isArray(data.providers) || data.legacyJackettMigrated !== true)) throw new Error();
    let providers = legacyFormat ? data : data.providers;
    if (providers.some((item) => !item || typeof item.id !== "string"
      || typeof item.name !== "string" || typeof item.enabled !== "boolean"
      || !Array.isArray(item.capabilities?.mediaTypes) || !item.capabilities?.modes)) throw new Error();
    const hadLegacy = providers.some((item) => item.legacyJackett);
    providers = providers.map((item) => {
      if (!item.legacyJackett) return item;
      const match = String(item.endpoint || "").match(/\/indexers\/([a-z\d._-]+)\/results\/torznab\/api\/?$/i);
      if (!match) throw new Error();
      const { endpoint: _endpoint, apiKey: _apiKey, legacyJackett: _legacyJackett, ...rest } = item;
      return { ...rest, kind: "jackett", indexerId: match[1] };
    });
    // An older edit could strip the migration flag while retaining its deterministic ID.
    // Prefer the service-linked record if both versions were written during an upgrade.
    providers = providers.filter((item, index) => !providers.some((other, otherIndex) => otherIndex > index
      && other.id === item.id && other.kind === "jackett"));
    const shouldMigrate = legacyFormat && !hadLegacy && (!exists || providers.length > 0);
    if (shouldMigrate) providers = migrateLegacyJackett(providers, environment);
    const validated = providers.map((item) => {
      if (!item || typeof item.id !== "string" || typeof item.name !== "string" || typeof item.enabled !== "boolean"
        || !Array.isArray(item.capabilities?.mediaTypes) || !item.capabilities?.modes) throw new Error();
      if (item.kind === "jackett") {
        jackettEndpoint("http://localhost", item.indexerId);
        if (!item.id.startsWith("custom-") && !item.id.startsWith("jackett-")) throw new Error();
        return item;
      }
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
    const store = { version: 2, legacyJackettMigrated: true, providers: validated };
    const pendingLegacy = (String(environment.JACKETT_MOVIE_INDEXERS || "").trim()
      || String(environment.JACKETT_SHOW_INDEXERS || "").trim())
      && (!String(environment.JACKETT_URL || "").trim() || !String(environment.JACKETT_API_KEY || "").trim()
        || String(environment.JACKETT_API_KEY).trim() === "replace-me");
    if (legacyFormat && !pendingLegacy && (exists || validated.length)) {
      writeStoreSync({ ...store, providers: persistedProviders(validated) }, environment);
    }
    return store;
  } catch (error) {
    if (error.status) throw error;
    throw fail("Custom provider configuration could not be read or legacy Jackett settings could not be converted.", 500);
  }
}
export function readCustomProviders(environment = process.env) {
  return readProviderStore(environment).providers;
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
  const selected = override === undefined ? null : providerIds(override);
  return providers.filter((item) => item.enabled && (!selected || selected.includes(item.id) || (item.kind === "jackett" && selected.includes("jackett"))));
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
      id, name, enabled, kind: provider.kind === "jackett" ? "jackett" : "torznab",
      type: provider.kind === "jackett" ? "Jackett" : "Torznab",
      mediaTypes: provider.searchMediaTypes || capabilities.mediaTypes,
      active: active.some((item) => item.id === id), apiKeyConfigured: Boolean(provider.apiKey),
      ...(provider.kind === "jackett" ? { indexerId: provider.indexerId } : canEdit ? { endpoint: provider.endpoint } : {}),
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
  if (previous?.kind === "cardigann" || previous?.kind === "jackett") throw fail("This source uses its own settings.", 400);
  try { return await testTorznab(candidate(values, previous), options); }
  catch { throw fail("Connection test failed. Check the endpoint, API key, and movie/TV capabilities.", 422); }
}
export async function availableJackettIndexers({ environment = process.env, ...options } = {}) {
  try {
    const providers = readCustomProviders(environment);
    return (await listJackettIndexers({ environment, ...options })).map((item) => ({
      ...item, added: providers.some((provider) => provider.kind === "jackett" && provider.indexerId === item.id),
    }));
  } catch { throw fail("Jackett could not be verified. Check its URL, API key, and service status.", 422); }
}
export async function jackettIndexerCapabilities(indexerId, { environment = process.env, ...options } = {}) {
  try {
    const service = configuredJackett(environment);
    const indexers = await listJackettIndexers({ environment, ...options });
    if (!indexers.some((item) => item.id === indexerId)) throw new Error();
    return await testTorznab({ endpoint: jackettEndpoint(service.url, indexerId), apiKey: service.apiKey }, options);
  } catch { throw fail("Jackett indexer could not be verified.", 422); }
}
export function changeJackettProvider(action, values, { environment = process.env, ...options } = {}) {
  return serializeSettingsWrite(async () => {
    const providers = readCustomProviders(environment);
    const previous = action === "update" ? providers.find((item) => item.id === values.id && item.kind === "jackett") : null;
    if (action === "update" && !previous) throw fail("Jackett source not found.", 404);
    if (previous && typeof values.enabled === "boolean"
      && Array.isArray(values.mediaTypes) && JSON.stringify(values.mediaTypes) === JSON.stringify(previous.searchMediaTypes)) {
      return saveProviders(providers.map((item) => item.id === previous.id ? { ...item, enabled: values.enabled } : item), environment);
    }
    if (action === "create" && providers.length >= 20) throw fail("A maximum of 20 sources is supported.");
    const indexerId = previous?.indexerId || values.indexerId;
    if (action === "create" && providers.some((item) => item.kind === "jackett" && item.indexerId === indexerId)) throw fail("This Jackett indexer is already added.");
    const capabilities = await jackettIndexerCapabilities(indexerId, { environment, ...options });
    const mediaTypes = values.mediaTypes;
    if (!Array.isArray(mediaTypes) || !mediaTypes.length || mediaTypes.some((item) => !["Movies", "TV"].includes(item) || !capabilities.mediaTypes.includes(item))) {
      throw fail("Choose at least one movie or TV type supported by this Jackett indexer.");
    }
    const indexers = await listJackettIndexers({ environment, ...options });
    const indexer = indexers.find((item) => item.id === indexerId);
    if (!indexer) throw fail("Jackett indexer is no longer configured.", 422);
    const next = {
      id: previous?.id || `jackett-${randomUUID()}`, kind: "jackett", indexerId,
      name: `Jackett (${indexer.name})`, enabled: values.enabled ?? previous?.enabled ?? true,
      searchMediaTypes: [...new Set(mediaTypes)], genericEnabled: true, capabilities,
    };
    if (typeof next.enabled !== "boolean") throw fail("Enabled must be a boolean.");
    return saveProviders([...providers.filter((item) => item.id !== previous?.id), next], environment);
  });
}
export function changeCustomProvider(action, values, { environment = process.env, ...options } = {}) {
  return serializeSettingsWrite(async () => {
    const providers = readCustomProviders(environment);
    if (action === "create" && providers.length >= 20) throw fail("A maximum of 20 custom providers is supported.");
    const previous = providers.find((item) => item.id === values.id);
    if (action === "create" && values.id) throw fail("New providers must not include an ID.");
    if (action !== "create" && !previous) throw fail("Provider not found.", 404);
    if (previous?.kind === "cardigann" || (previous?.kind === "jackett" && action !== "remove")) throw fail("This source uses its own settings.", 400);
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
      await writeFile(temporary, JSON.stringify({ version: 2, legacyJackettMigrated: true, providers: persistedProviders(next) }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
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
      await writeFile(temporary, JSON.stringify({ version: 2, legacyJackettMigrated: true, providers: persistedProviders(providers) }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
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
        await testCardigannProvider(provider, { environment, ...options });
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
        await testCardigannProvider(next, { environment, ...options });
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
      await testCardigannProvider(previous, { environment, ...options });
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
    const key = provider.kind === "jackett"
      ? JSON.stringify([provider, environment.JACKETT_URL,
        createHash("sha256").update(String(environment.JACKETT_API_KEY || "")).digest("hex")])
      : JSON.stringify(provider);
    const cached = health.get(key);
    if (!refresh && cached?.expires > Date.now()) return cached.result;
    let status = "connected";
    let diagnostic;
    try {
      if (provider.kind === "cardigann") await testCardigannProvider(provider, { environment, ...options });
      else await testTorznab(provider.kind === "jackett" ? jackettProvider(provider, environment) : provider, options);
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
