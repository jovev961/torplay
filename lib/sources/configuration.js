import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { stringify } from "yaml";
import { readJsonFile, writeJsonFile } from "../settings/json-file.js";
import { serializeSettingsWrite } from "../settings/write-queue.js";
import { withDeadline, endpointUrl } from "../network/request.js";
import { SourceError, diagnostic, text } from "./contract.js";
import { testedSources, verifyNative } from "./native.js";
import { torznabEndpoint, verifyTorznab, jackettSource, listJackettIndexers } from "./torznab.js";
import { importedDefinition, consumeImportedDefinition, parseDefinition, validateDefinitionObject,
  definitionSettings, configurationComplete, settingDescriptors, requiresFlareSolverr } from "./cardigann/definition.js";
import { verifyCardigann } from "./cardigann/engine.js";

const healthKey = Symbol.for("torplay.sources.health");
function healthCache() { return globalThis[healthKey] ??= new Map(); }
function files(environment) {
  const root = path.dirname(path.resolve(/* turbopackIgnore: true */ environment.TORPLAY_CONFIG_PATH?.trim() || ".env.local"));
  return { native: path.join(root, "native-sources.json"), custom: path.join(root, "torrent-providers.json") };
}

export function configurationFingerprint(source, environment = process.env) {
  const { verification: _verification, ...configuration } = source;
  return createHash("sha256").update(JSON.stringify({ source: configuration,
    ...(source.kind === "jackett" ? { url: environment.JACKETT_URL, key: environment.JACKETT_API_KEY } : {}),
    ...(source.kind === "cardigann" ? { solver: environment.FLARESOLVERR_URL } : {}),
  })).digest("hex");
}

function legacyJackett(custom, environment) {
  const movie = String(environment.JACKETT_MOVIE_INDEXERS || "").split(",").map((id) => id.trim()).filter(Boolean);
  const show = String(environment.JACKETT_SHOW_INDEXERS || "").split(",").map((id) => id.trim()).filter(Boolean);
  if (!movie.length && !show.length) return custom;
  const ids = [...new Set([...(movie.length ? movie : ["all"]), ...(show.length ? show : ["all"])])];
  const converted = ids.map((indexerId) => {
    const endpoint = jackettSource({ indexerId }, environment).endpoint;
    const id = `custom-${createHash("sha256").update(`legacy-jackett:${endpoint}`).digest("hex").slice(0, 24)}`;
    const mediaTypes = [...(movie.includes(indexerId) || (!movie.length && indexerId === "all") ? ["Movies"] : []),
      ...(show.includes(indexerId) || (!show.length && indexerId === "all") ? ["TV"] : [])];
    return { id, name: `Jackett (${indexerId})`, kind: "jackett", indexerId, enabled: true,
      genericEnabled: [...movie, ...show].includes(indexerId), searchMediaTypes: mediaTypes,
      capabilities: { mediaTypes: mediaTypes.length ? mediaTypes : ["Movies", "TV"], modes: { search: ["q"], movie: ["q"], tvsearch: ["q", "season", "ep"] }, limit: 50 } };
  });
  return [...custom, ...converted.filter((source) => !custom.some((previous) => previous.id === source.id
    || previous.endpoint === jackettSource(source, environment).endpoint))];
}

function hydrate(record, environment = process.env) {
  if (!record || typeof record.id !== "string" || typeof record.enabled !== "boolean") {
    throw new SourceError("CONFIGURATION_REQUIRED", "A configured source record is invalid.", 500);
  }
  if (!/^[a-z0-9][a-z0-9._-]{0,99}$/i.test(record.id) || !text(record.name, 100)) {
    return { ...record, name: text(record.name, 100) || "Configured source", configurationError: "Source identity needs correction." };
  }
  let source = { ...record, name: text(record.name, 100), kind: record.kind || "torznab" };
  delete source.configurationError;
  try {
    if (record.legacyJackett) {
      const match = new URL(torznabEndpoint(record.endpoint)).pathname.match(/\/indexers\/([a-z\d._-]+)\/results\/torznab\/api\/?$/i);
      if (!match) throw new Error();
      // The marker explicitly identifies a service-linked source. Keep the old
      // record intact until the service configuration can represent it safely.
      jackettSource({ indexerId: match[1] }, environment);
      const { endpoint: _endpoint, apiKey: _apiKey, legacyJackett: _legacy, ...retained } = source;
      source = { ...retained, kind: "jackett", indexerId: match[1] };
    }
    if (source.kind === "cardigann") {
      const yaml = source.definitionYaml || stringify(source.definition);
      const hash = createHash("sha256").update(yaml).digest("hex");
      if (source.definitionYaml && source.definitionHash !== hash) throw new Error();
      const parsed = source.definitionYaml ? parseDefinition(yaml, { allowUnsupported: true })
        : validateDefinitionObject(source.definition, { allowUnsupported: true });
      source = { ...source, ...parsed, definitionYaml: yaml, definitionHash: hash,
        definitionSourceFormat: source.definitionSourceFormat || "canonicalized-legacy",
        settings: definitionSettings(parsed.definition, source.settings || {}) };
    } else if (source.kind === "torznab") {
      source.endpoint = torznabEndpoint(source.endpoint);
      if (typeof source.apiKey !== "string" || source.apiKey.length > 4096 || /[\r\n\0]/.test(source.apiKey)) throw new Error();
    }
    else if (source.kind === "jackett") {
      if (!/^[a-z\d][a-z\d._-]{0,99}$/i.test(source.indexerId || "")) throw new Error();
    } else throw new Error();
    if (["torznab", "jackett"].includes(source.kind)) {
      source.capabilities = capabilities(source.capabilities);
      if (source.searchMediaTypes !== undefined && (!Array.isArray(source.searchMediaTypes)
        || source.searchMediaTypes.some((type) => !["Movies", "TV"].includes(type)))) throw new Error();
    }
  } catch { source.configurationError = "This saved source cannot be represented safely. Edit or remove it."; }
  return source;
}

export function readConfiguration(environment = process.env) {
  const filenames = files(environment);
  const native = readJsonFile(filenames.native, []);
  const stored = readJsonFile(filenames.custom, []);
  if (!Array.isArray(native) || (!Array.isArray(stored) && (stored?.version !== 2 || !Array.isArray(stored.providers)))) {
    throw new SourceError("CONFIGURATION_REQUIRED", "Source configuration has an unsupported format.", 500);
  }
  const records = Array.isArray(stored) ? stored : stored.providers;
  const custom = records.map((record) => hydrate(record, environment));
  const known = new Set();
  for (const source of [...native, ...custom]) {
    if (!source || typeof source.id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,99}$/i.test(source.id)
      || typeof source.enabled !== "boolean" || known.has(source.id)) {
      throw new SourceError("CONFIGURATION_REQUIRED", "Source configuration contains invalid or duplicate identities.", 500);
    }
    known.add(source.id);
  }
  let providers = custom, migrationError = null;
  if (Array.isArray(stored) && !records.some((record) => record.legacyJackett)) {
    try { providers = legacyJackett(custom, environment); }
    catch { migrationError = "Legacy source settings could not be migrated. Configure the external service before continuing."; }
  }
  return { native, custom: providers, migrationError, migrationNeeded: Array.isArray(stored) };
}

function selection(environment) {
  return environment.TORPLAY_SEARCH_PROVIDERS === undefined ? null
    : new Set(String(environment.TORPLAY_SEARCH_PROVIDERS).split(",").map((id) => id.trim()).filter(Boolean));
}

function active(source, environment) {
  const selected = selection(environment);
  return source.enabled && (!selected || selected.has(source.id) || ((source.kind === "jackett" || source.legacyJackett) && selected.has("jackett")));
}

export function configuredSources(environment = process.env) {
  const config = readConfiguration(environment);
  const native = config.native.map((record) => ({ ...testedSources.find((source) => source.id === record.id),
    ...record, kind: "native", name: testedSources.find((source) => source.id === record.id)?.name || "Unknown configured source" }));
  return [...native, ...config.custom].filter((source) => active(source, environment));
}

function readiness(source, environment) {
  if (source.configurationError) return { status: "configuration-required", message: source.configurationError };
  if (source.kind === "native" && !testedSources.some((item) => item.id === source.id)) return { status: "unsupported", message: "Unknown configured source." };
  if (source.kind === "cardigann") {
    if (!source.compatibility.supported) return { status: "unsupported", message: "This definition requires unsupported features." };
    if (!configurationComplete(source.definition, source.settings)) return { status: "configuration-required", message: "Complete the source configuration." };
    if (requiresFlareSolverr(source.definition) && !environment.FLARESOLVERR_URL) return { status: "requires-flaresolverr", message: "Requires FlareSolverr." };
  }
  if (source.kind === "jackett") {
    try { jackettSource(source, environment); } catch { return { status: "configuration-required", message: "Configure the external Jackett service." }; }
  }
  return { status: "ready", message: "Source configuration is ready." };
}

export function sourceSnapshot(environment = process.env, canEdit = false) {
  const config = readConfiguration(environment);
  const nativeSources = [...testedSources, ...config.native.filter((record) => !testedSources.some((source) => source.id === record.id))
    .map((record) => ({ id: record.id, name: "Unknown configured source", description: "Saved source requires correction.", mediaTypes: [] }))]
    .map((source) => {
      const record = config.native.find((item) => item.id === source.id);
      return { ...source, configured: Boolean(record), enabled: record?.enabled === true,
        active: record ? active(record, environment) : false };
    });
  const customProviders = config.custom.map((source) => {
    const configured = readiness(source, environment);
    const storedVerification = source.verification;
    const verification = storedVerification?.status === "verified"
      ? { status: "verified", message: "Connection was verified.", checkedAt: typeof storedVerification.checkedAt === "string" ? storedVerification.checkedAt : null }
      : { status: "unverified", message: "Connection has not been verified." };
    const common = { id: source.id, name: source.name, kind: source.kind, enabled: source.enabled,
      active: active(source, environment), type: source.kind === "cardigann" ? "Cardigann" : source.kind === "jackett" ? "Jackett" : "Torznab",
      mediaTypes: source.configurationError ? [] : source.searchMediaTypes || source.capabilities?.mediaTypes || ["Movies", "TV"],
      configuration: configured, verification, canConfigure: !source.configurationError };
    if (source.configurationError) return { ...common, settings: [], categories: [], compatibility: { supported: false } };
    if (source.kind === "cardigann" && source.definition) {
      let definitionUrl;
      try { definitionUrl = endpointUrl(source.definitionUrl, { base: true }).href; } catch { /* Signed/private import locators stay private. */ }
      return { ...common, definitionId: source.definition.id, ...(canEdit && definitionUrl ? { definitionUrl } : {}),
        access: source.definition.type, categories: source.capabilities.categories,
        compatibility: source.compatibility, requiresFlareSolverr: requiresFlareSolverr(source.definition),
        ...(canEdit ? { settings: settingDescriptors(source.definition, source.settings) } : {}) };
    }
    return { ...common, apiKeyConfigured: Boolean(source.apiKey),
      ...(source.kind === "jackett" ? { indexerId: source.indexerId } : canEdit ? { endpoint: source.endpoint } : {}) };
  });
  return { nativeSources, customProviders, ...(config.migrationError ? { sourceConfigurationError: config.migrationError } : {}) };
}

function persisted(source) {
  const { definition: _definition, compatibility: _compatibility, configurationError: _error, ...record } = source;
  // An unrepresentable saved record is retained rather than silently discarded.
  return source.configurationError ? source : record;
}

async function save(config, environment, family = "custom") {
  const filenames = files(environment);
  if (config.migrationError) throw new SourceError("CONFIGURATION_REQUIRED", config.migrationError, 409);
  if (family === "custom" || config.migrationNeeded) {
    await writeJsonFile(filenames.custom, { version: 2, legacyJackettMigrated: true, providers: config.custom.map(persisted) });
  }
  if (family === "native") await writeJsonFile(filenames.native, config.native);
  healthCache().clear();
  return sourceSnapshot(environment, true);
}

function enabled(input, previous) {
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw new SourceError("CONFIGURATION_REQUIRED", "Enabled must be a boolean.", 400);
  return input.enabled ?? previous?.enabled ?? false;
}

export async function verifySource(source, { environment = process.env, ...options } = {}) {
  const state = readiness(source, environment);
  if (state.status !== "ready") return { ...state, checkedAt: new Date().toISOString() };
  try {
    const capabilities = await withDeadline((signal) => source.kind === "native" ? verifyNative(source, { ...options, signal })
      : source.kind === "cardigann" ? verifyCardigann(source, { ...options, environment, signal })
        : verifyTorznab(source.kind === "jackett" ? jackettSource(source, environment) : source, { ...options, signal }),
    { signal: options.signal, timeoutMs: options.timeoutMs ?? 120_000 });
    return { status: "verified", message: "Connection verified.", checkedAt: new Date().toISOString(),
      ...(capabilities && typeof capabilities === "object" ? { capabilities } : {}) };
  } catch (error) {
    options.signal?.throwIfAborted();
    return { ...diagnostic(error), checkedAt: new Date().toISOString() };
  }
}

export async function sourceHealth({ environment = process.env, refresh = false, signal, onCached, onResult } = {}) {
  const config = readConfiguration(environment);
  const sources = [...config.native.map((source) => ({ ...testedSources.find((item) => item.id === source.id), ...source, kind: "native" })), ...config.custom];
  return Promise.all(sources.map(async (source) => {
    signal?.throwIfAborted();
    let state;
    if (!active(source, environment)) state = { status: "disabled", message: "Source is disabled or excluded by the source selection." };
    else {
      const key = configurationFingerprint(source, environment);
      const cache = healthCache();
      const cached = cache.get(key);
      if (cached) onCached?.(cached.value, refresh || cached.expiresAt <= Date.now());
      if (!refresh && cached?.expiresAt > Date.now()) return cached.value;
      state = await verifySource(source, { environment, signal });
      signal?.throwIfAborted();
      const result = { provider: source.id, ...state };
      while (cache.size >= 200) cache.delete(cache.keys().next().value);
      cache.set(key, { value: result, expiresAt: Date.now() + 60_000 });
    }
    const result = { provider: source.id, ...state };
    onResult?.(result);
    return result;
  }));
}

export async function configure(action, input = {}, { environment = process.env, ...options } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new SourceError("CONFIGURATION_REQUIRED", "Source configuration is required.", 400);
  if (action === "jackett-indexers") {
    const configured = readConfiguration(environment).custom;
    return { indexers: (await listJackettIndexers({ environment, ...options })).map((item) => ({ ...item,
      added: configured.some((source) => source.kind === "jackett" && source.indexerId === item.id) })) };
  }
  if (action === "jackett-capabilities") return { capabilities: await verifyTorznab(jackettSource(input, environment), options) };
  if (action === "test") {
    const previous = input.id ? readConfiguration(environment).custom.find((source) => source.id === input.id) : null;
    const source = torznabValues(input, previous);
    return { capabilities: await withDeadline((signal) => verifyTorznab(source, { ...options, signal }), { signal: options.signal }) };
  }
  if (action === "test-cardigann") {
    const previous = readConfiguration(environment).custom.find((source) => source.id === input.id && source.kind === "cardigann");
    if (!previous) throw new SourceError("SOURCE_NOT_FOUND", "Source not found.", 404);
    const verification = await verifySource(previous, { environment, ...options });
    const fingerprint = configurationFingerprint(previous, environment);
    return serializeSettingsWrite(async () => {
      const config = readConfiguration(environment);
      const current = config.custom.find((source) => source.id === previous.id);
      if (!current || configurationFingerprint(current, environment) !== fingerprint) throw new SourceError("CONFIGURATION_CHANGED", "The source changed during verification. Try again.", 409);
      current.verification = verification;
      const result = await save(config, environment);
      return { providers: result.customProviders, verification };
    });
  }
  return serializeSettingsWrite(async () => {
    const config = readConfiguration(environment);
    if (["add-native", "update-native", "remove-native"].includes(action)) {
      if (!testedSources.some((source) => source.id === input.id) && action === "add-native") throw new SourceError("CONFIGURATION_REQUIRED", "Unknown native source.", 400);
      const previous = config.native.find((source) => source.id === input.id);
      if (action === "add-native" && previous) throw new SourceError("SOURCE_EXISTS", "This source is already configured.", 409);
      if (action !== "add-native" && !previous) throw new SourceError("SOURCE_NOT_FOUND", "Source not found.", 404);
      config.native = config.native.filter((source) => source.id !== input.id);
      if (action !== "remove-native") config.native.push({ id: input.id, enabled: enabled(input, previous) });
    } else {
      const previous = config.custom.find((source) => source.id === input.id);
      const creating = ["create", "create-cardigann", "create-jackett"].includes(action);
      const removing = ["remove", "remove-cardigann"].includes(action);
      if (!creating && !previous) throw new SourceError("SOURCE_NOT_FOUND", "Source not found.", 404);
      if (creating && config.custom.length >= 20) throw new SourceError("SOURCE_LIMIT", "A maximum of 20 custom sources is supported.", 400);
      let next;
      if (action === "set-enabled") {
        if (typeof input.enabled !== "boolean") throw new SourceError("CONFIGURATION_REQUIRED", "Enabled must be a boolean.", 400);
        next = { ...previous, enabled: input.enabled };
      } else if (action === "create-cardigann") {
        const imported = importedDefinition(input.importId);
        if (config.custom.some((source) => source.kind === "cardigann" && source.definition?.id === imported.definition.id)) throw new SourceError("SOURCE_EXISTS", "This definition is already configured.", 409);
        next = hydrate({ id: `cardigann-${randomUUID()}`, kind: "cardigann", name: imported.definition.name,
          enabled: enabled(input), definitionUrl: imported.sourceUrl, definitionYaml: imported.definitionYaml,
          definitionHash: imported.hash, definitionSourceFormat: "original", settings: definitionSettings(imported.definition, input.settings || {}) }, environment);
      } else if (action === "update-cardigann") {
        if (previous.kind !== "cardigann") throw new SourceError("CONFIGURATION_REQUIRED", "Choose a Cardigann source.", 400);
        next = { ...previous, enabled: enabled(input, previous), settings: input.settings === undefined ? previous.settings
          : definitionSettings(previous.definition, input.settings, previous.settings) };
      } else if (["create-jackett", "update-jackett"].includes(action)) {
        const indexerId = previous?.indexerId || input.indexerId;
        if (!/^[a-z\d][a-z\d._-]{0,99}$/i.test(indexerId || "")) throw new SourceError("CONFIGURATION_REQUIRED", "Choose a valid Jackett indexer.", 400);
        if (config.custom.some((source) => source.id !== previous?.id && source.kind === "jackett" && source.indexerId === indexerId)) throw new SourceError("SOURCE_EXISTS", "This indexer is already configured.", 409);
        if (!Array.isArray(input.mediaTypes) || !input.mediaTypes.length || input.mediaTypes.some((type) => !["Movies", "TV"].includes(type))) throw new SourceError("CONFIGURATION_REQUIRED", "Choose movie or TV support.", 400);
        next = { ...previous, id: previous?.id || `jackett-${randomUUID()}`, kind: "jackett", indexerId,
          name: previous?.name || `Jackett (${indexerId})`, enabled: enabled(input, previous),
          searchMediaTypes: [...new Set(input.mediaTypes)], genericEnabled: true,
          capabilities: capabilities(input.capabilities ?? previous?.capabilities) };
        if (next.searchMediaTypes.some((type) => !next.capabilities.mediaTypes.includes(type))) throw new SourceError("CONFIGURATION_REQUIRED", "Choose media types supported by this indexer.", 400);
      } else if (["create", "update"].includes(action)) {
        if (previous && previous.kind !== "torznab") throw new SourceError("CONFIGURATION_REQUIRED", "Choose a Torznab source.", 400);
        next = torznabValues(input, previous);
        if (config.custom.some((source) => source.id !== next.id && source.endpoint === next.endpoint)) throw new SourceError("SOURCE_EXISTS", "This endpoint is already configured.", 409);
      } else if (!removing) throw new SourceError("INVALID_ACTION", "Unknown source action.", 400);
      if (next && configurationFingerprint({ ...next, enabled: previous?.enabled }, environment) !== configurationFingerprint(previous || {}, environment)) {
        next.verification = { status: "unverified", message: "Configuration changed. Verify the source separately." };
      }
      config.custom = config.custom.filter((source) => source.id !== previous?.id);
      if (next) config.custom.push(next);
    }
    const result = await save(config, environment, action.endsWith("-native") ? "native" : "custom");
    if (action === "create-cardigann") consumeImportedDefinition(input.importId);
    return { providers: result.customProviders, nativeSources: result.nativeSources };
  });
}

function torznabValues(input, previous) {
  const name = typeof (input.name ?? previous?.name) === "string" ? (input.name ?? previous.name).trim() : "";
  if (!name || name.length > 100 || /[\r\n\0]/.test(name)) throw new SourceError("CONFIGURATION_REQUIRED", "Enter a source name up to 100 characters.", 400);
  const apiKey = input.clearApiKey ? "" : String(input.apiKey || previous?.apiKey || "").trim();
  if (apiKey.length > 4096 || /[\r\n\0]/.test(apiKey)) throw new SourceError("CONFIGURATION_REQUIRED", "Invalid API key.", 400);
  const endpoint = torznabEndpoint(input.endpoint ?? previous?.endpoint);
  const connectionChanged = previous && (endpoint !== previous.endpoint || apiKey !== previous.apiKey);
  return { ...previous, id: previous?.id || `custom-${randomUUID()}`, kind: "torznab", name,
    endpoint, apiKey, enabled: enabled(input, previous),
    capabilities: capabilities(input.capabilities ?? (connectionChanged ? undefined : previous?.capabilities)) };
}

function capabilities(input) {
  if (input === undefined) return { mediaTypes: ["Movies", "TV"], modes: { search: ["q"] }, limit: 50 };
  if (!input || !Array.isArray(input.mediaTypes) || !input.mediaTypes.length
    || input.mediaTypes.some((type) => !["Movies", "TV"].includes(type))
    || !input.modes || typeof input.modes !== "object" || Array.isArray(input.modes)) {
    throw new SourceError("CONFIGURATION_REQUIRED", "Indexer capabilities are invalid.", 400);
  }
  const modes = Object.fromEntries(Object.entries(input.modes).map(([mode, parameters]) => {
    if (!["search", "movie", "tvsearch"].includes(mode) || !Array.isArray(parameters) || parameters.length > 30
      || parameters.some((value) => typeof value !== "string" || !/^[a-z\d_-]{1,40}$/i.test(value))) {
      throw new SourceError("CONFIGURATION_REQUIRED", "Indexer search capabilities are invalid.", 400);
    }
    return [mode, [...new Set(parameters)]];
  }));
  return { mediaTypes: [...new Set(input.mediaTypes)], modes, limit: 50 };
}
