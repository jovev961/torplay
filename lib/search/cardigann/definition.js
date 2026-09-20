import { createHash, randomUUID } from "node:crypto";
import Ajv2019 from "ajv/dist/2019.js";
import addFormats from "ajv-formats";
import { parseDocument } from "yaml";
import schema from "./schema-v11.json" with { type: "json" };
import { classifyRequestFailure, safeRequest } from "./http.js";
import { CARDIGANN_FILTERS } from "./filters.js";
import { parseTemplate } from "./template.js";

const importsKey = Symbol.for("torplay.cardigannImports");
const IMPORT_TTL_MS = 10 * 60 * 1000;
const ajv = new Ajv2019({ allErrors: true, strict: false });
addFormats(ajv);
const validateSchema = ajv.compile(schema);

function fail(message, status = 422, code = "CARDIGANN_INVALID", unsupportedFeatures) {
  return Object.assign(new Error(message), { status, code, unsupportedFeatures });
}

function imports() {
  globalThis[importsKey] ??= new Map();
  const store = globalThis[importsKey];
  const now = Date.now();
  for (const [id, item] of store) if (item.expiresAt <= now) store.delete(id);
  return store;
}

export function normalizeDefinitionUrl(value) {
  let url;
  try { url = new URL(String(value || "").trim()); } catch { throw fail("Enter a valid definition URL.", 400, "CARDIGANN_URL_INVALID"); }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw fail("Definition URLs must use public HTTPS without embedded credentials.", 400, "CARDIGANN_URL_UNSUPPORTED");
  }
  url.hash = "";
  if (url.hostname.toLowerCase() === "github.com") {
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 5 || parts[2] !== "blob") {
      throw fail("Use the GitHub page for an individual .yml or .yaml definition file.", 400, "CARDIGANN_URL_INVALID");
    }
    url = new URL(`https://raw.githubusercontent.com/${parts[0]}/${parts[1]}/${parts.slice(3).join("/")}`);
  }
  if (!/\.ya?ml$/i.test(url.pathname)) throw fail("Definition URLs must point to a .yml or .yaml file.", 400, "CARDIGANN_URL_INVALID");
  return url.toString();
}

function walk(value, visit, path = "definition") {
  visit(value, path);
  if (Array.isArray(value)) value.forEach((item, index) => walk(item, visit, `${path}[${index}]`));
  else if (value && typeof value === "object") {
    Object.entries(value).forEach(([key, item]) => walk(item, visit, `${path}.${key}`));
  }
}

const ROW_FILTERS = new Set(["andmatch", "strdump"]);

function compatibility(definition) {
  const unsupported = [];
  const add = (feature, path, message) => {
    if (!unsupported.some((item) => item.path === path && item.feature === feature)) {
      unsupported.push({ feature, path, message });
    }
  };
  if (definition.login?.captcha) add("captcha", "definition.login.captcha", "CAPTCHA-based login is not supported.");
  if (definition.certificates?.length) add("certificates", "definition.certificates", "Definition-specific certificate pinning is not supported.");
  if (definition.testlinktorrent === true) add("testlinktorrent", "definition.testlinktorrent", "Torrent-link self-testing is not supported.");
  const categories = [
    ...Object.values(definition.caps?.categories || {}).map(String),
    ...(definition.caps?.categorymappings || []).map((item) => String(item.cat || "")),
  ];
  if (!categories.some((name) => name === "Movies" || name.startsWith("Movies/") || name === "TV" || name.startsWith("TV/"))) {
    add("media-types", "definition.caps", "The definition does not provide movie or TV categories supported by TorPlay.");
  }
  try { new TextDecoder(definition.encoding, { fatal: true }); } catch {
    add("encoding", "definition.encoding", `The ${definition.encoding} response encoding is not supported.`);
  }
  for (const [index, selector] of (definition.download?.selectors || []).entries()) {
    if (!selector || typeof selector !== "object" || Array.isArray(selector)) {
      add("download.selector", `definition.download.selectors[${index}]`, "Download selectors must use Cardigann selector objects.");
      continue;
    }
    for (const key of Object.keys(selector)) {
      if (!["selector", "attribute", "usebeforeresponse", "filters"].includes(key)) {
        add("download.selector", `definition.download.selectors[${index}].${key}`, `The ${key} download-selector option is not supported.`);
      }
    }
    if (typeof selector.selector !== "string") add("download.selector", `definition.download.selectors[${index}].selector`, "Download selectors require a selector string.");
  }
  for (const [index, setting] of (definition.settings || []).entries()) {
    if (setting.type === "info_flaresolverr") {
      add("flaresolverr", `definition.settings[${index}]`, "This definition requires FlareSolverr or anti-bot handling, which TorPlay does not provide.");
    }
  }
  walk(definition, (value, path) => {
    if (typeof value === "string" && value.includes("{{")) {
      try { parseTemplate(value); } catch (error) { add("template", path, error.message); }
    }
    if (Array.isArray(value) && /(?:filters|keywordsfilters|preprocessingfilters)$/.test(path)) {
      const allowed = path.endsWith("search.rows.filters") ? new Set([...CARDIGANN_FILTERS, ...ROW_FILTERS]) : CARDIGANN_FILTERS;
      value.forEach((filter, index) => {
        if (!allowed.has(filter?.name)) add("filter", `${path}[${index}]`, `The ${filter?.name || "unknown"} Cardigann filter is not supported.`);
      });
    }
  });
  if (unsupported.length) {
    const count = unsupported.length;
    throw fail(
      `This definition cannot be imported because TorPlay does not support ${count} required Cardigann ${count === 1 ? "feature" : "features"}.`,
      422,
      "CARDIGANN_UNSUPPORTED",
      unsupported,
    );
  }
  return { schemaVersion: 11, supported: true };
}

function categoryNames(definition) {
  const names = Object.values(definition.caps?.categories || {}).map(String);
  for (const item of definition.caps?.categorymappings || []) if (item.cat) names.push(String(item.cat));
  return names;
}

export function definitionCapabilities(definition) {
  const categories = categoryNames(definition);
  const modes = definition.caps?.modes || {};
  const mediaTypes = [
    ...(categories.some((name) => name === "Movies" || name.startsWith("Movies/")) ? ["Movies"] : []),
    ...(categories.some((name) => name === "TV" || name.startsWith("TV/")) ? ["TV"] : []),
  ];
  return { mediaTypes, modes };
}

function definitionSettings(definition) {
  if (Array.isArray(definition.settings)) return definition.settings;
  return definition.login ? [
    { name: "username", label: "Username", type: "text" },
    { name: "password", label: "Password", type: "password" },
  ] : [];
}

export function settingDescriptors(definition, values = {}) {
  return definitionSettings(definition).flatMap((setting) => {
    if (setting.type.startsWith("info")) return [];
    const secret = setting.type === "password" || /(?:cookie|pass|secret|token|api.?key)/i.test(setting.name);
    const current = values[setting.name];
    const defaultValue = setting.default ?? setting.defaults?.[0];
    return [{
      name: setting.name,
      label: setting.label || setting.name,
      type: setting.type,
      options: setting.options || null,
      default: defaultValue ?? null,
      required: setting.type !== "checkbox" && defaultValue === undefined,
      secret,
      configured: secret && current !== undefined && String(current) !== "",
      ...(!secret && current !== undefined ? { value: current } : {}),
    }];
  });
}

export function validateDefinitionSettings(definition, values = {}, previous = {}) {
  if (!values || typeof values !== "object" || Array.isArray(values)) throw fail("Indexer configuration must be an object.", 400);
  const fields = new Map(definitionSettings(definition).filter((item) => !item.type.startsWith("info")).map((item) => [item.name, item]));
  const unknown = Object.keys(values).find((key) => !fields.has(key));
  if (unknown) throw fail("Indexer configuration contains an unknown field.", 400);
  const output = {};
  for (const [name, field] of fields) {
    let value = values[name];
    const secret = field.type === "password" || /(?:cookie|pass|secret|token|api.?key)/i.test(name);
    if (secret && (value === undefined || value === "") && previous[name] !== undefined) value = previous[name];
    const defaultValue = field.default ?? field.defaults?.[0];
    if (value === undefined && defaultValue !== undefined) value = defaultValue;
    if (field.type === "checkbox") value = value === undefined ? false : value;
    if (field.type === "checkbox" && typeof value !== "boolean") throw fail(`${field.label || name} must be enabled or disabled.`, 400);
    if (["text", "password", "select"].includes(field.type)) {
      value = String(value ?? "").trim();
      if (!value && defaultValue === undefined) throw fail(`${field.label || name} is required.`, 400);
      if (value.length > 4096 || /[\r\n\0]/.test(value)) throw fail(`${field.label || name} is invalid.`, 400);
    }
    if (field.type === "select" && field.options && !Object.hasOwn(field.options, value)) throw fail(`${field.label || name} has an invalid option.`, 400);
    output[name] = value;
  }
  return output;
}

export function validateDefinitionObject(definition) {
  if (!validateSchema(definition)) {
    const detail = validateSchema.errors?.slice(0, 3).map((error) => `${error.instancePath || "definition"} ${error.message}`).join("; ");
    throw fail(`The file is not a valid Cardigann v11 definition${detail ? `: ${detail}` : "."}`);
  }
  const compatibilityResult = compatibility(definition);
  const capabilities = definitionCapabilities(definition);
  return { definition, capabilities, compatibility: compatibilityResult };
}

export function parseDefinition(source) {
  let document;
  try {
    document = parseDocument(String(source), { maxAliasCount: 50, prettyErrors: false, uniqueKeys: true });
  } catch {
    throw fail("The definition contains invalid YAML.");
  }
  if (document.errors.length) throw fail("The definition contains invalid YAML.");
  return validateDefinitionObject(document.toJS({ maxAliasCount: 50 }));
}

export async function importDefinition(definitionUrl, options = {}) {
  const sourceUrl = String(definitionUrl || "").trim();
  const resolvedUrl = normalizeDefinitionUrl(sourceUrl);
  let response;
  try {
    response = await (options.request || safeRequest)(resolvedUrl, {
      maxBytes: 1024 * 1024,
      timeoutMs: 15_000,
      protocols: ["https:"],
      requestImpl: options.requestImpl,
    });
  } catch (error) {
    const failure = classifyRequestFailure(error);
    throw fail(failure.message, failure.status, failure.code);
  }
  if (response.status < 200 || response.status >= 300) {
    throw fail(`The definition server returned HTTP ${response.status}.`, 422, "CARDIGANN_DOWNLOAD_HTTP");
  }
  const definitionYaml = response.body.toString("utf8");
  const parsed = parseDefinition(definitionYaml);
  const imported = {
    id: randomUUID(), sourceUrl, resolvedUrl, definitionYaml, ...parsed,
    hash: createHash("sha256").update(response.body).digest("hex"),
    expiresAt: Date.now() + IMPORT_TTL_MS,
  };
  imports().set(imported.id, imported);
  return {
    importId: imported.id,
    definition: {
      id: imported.definition.id,
      name: imported.definition.name,
      access: imported.definition.type,
      language: imported.definition.language,
      mediaTypes: imported.capabilities.mediaTypes,
      website: imported.definition.links[0] || null,
      sourceUrl: imported.sourceUrl,
      settings: settingDescriptors(imported.definition),
    },
    compatibility: imported.compatibility,
  };
}

export function importedDefinition(id) {
  const item = imports().get(String(id || ""));
  if (!item) throw fail("That imported definition expired. Import it again.", 404);
  return item;
}

export function consumeImportedDefinition(id) {
  imports().delete(id);
}
