import { createHash, randomUUID } from "node:crypto";
import Ajv2019 from "ajv/dist/2019.js";
import addFormats from "ajv-formats";
import { parseDocument } from "yaml";
import schema from "./schema-v11.json" with { type: "json" };
import { request, endpointUrl } from "../../network/request.js";
import { SourceError } from "../contract.js";
import { parseTemplate } from "./template.js";
import { CARDIGANN_FILTERS } from "./filters.js";
import { validateRegex } from "./regex.js";

const ajv = new Ajv2019({ strict: false, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(schema);
const importsKey = Symbol.for("torplay.sources.definitionImports");

export function definitionCapabilities(definition) {
  const categories = [...new Set([...Object.values(definition.caps?.categories || {}),
    ...(definition.caps?.categorymappings || []).map((item) => item.cat)].filter((item) => typeof item === "string"))];
  return { categories, modes: definition.caps?.modes || {}, mediaTypes: ["Movies", "TV"]
    .filter((type) => categories.some((category) => category === type || category.startsWith(`${type}/`))) };
}

function fields(definition) {
  return definition.settings || (definition.login ? [{ name: "username", label: "Username", type: "text" },
    { name: "password", label: "Password", type: "password" }] : []);
}
function secret(field) { return field.type === "password" || /cookie|pass|secret|token|api.?key/i.test(field.name); }
function required(field, definition) {
  if (field.type === "select") return field.default === undefined && field.defaults?.[0] === undefined;
  return ["text", "password"].includes(field.type) && JSON.stringify(definition.login || {}).includes(`.Config.${field.name}`);
}

export function settingDescriptors(definition, values = {}) {
  return fields(definition).map((field) => ({ name: field.name, label: field.label || field.name, type: field.type,
    informational: field.type.startsWith("info"), secret: secret(field),
    configured: secret(field) && Boolean(values[field.name]), required: required(field, definition),
    options: field.options || null, default: secret(field) ? null : field.default ?? field.defaults?.[0] ?? null,
    ...(!secret(field) && values[field.name] !== undefined ? { value: values[field.name] } : {}) }));
}

export function definitionSettings(definition, input = {}, previous = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new SourceError("CONFIGURATION_REQUIRED", "Source settings must be an object.", 400);
  const available = fields(definition).filter((field) => !field.type.startsWith("info"));
  if (Object.keys(input).some((name) => !available.some((field) => field.name === name))) throw new SourceError("CONFIGURATION_REQUIRED", "Unknown source setting.", 400);
  return Object.fromEntries(available.map((field) => {
    let value = input[field.name];
    if (secret(field) && (value === undefined || value === "") && previous[field.name] !== undefined) value = previous[field.name];
    value ??= field.default ?? field.defaults?.[0] ?? (field.type === "checkbox" ? false : "");
    if (field.type === "checkbox") {
      if (typeof value !== "boolean") throw new SourceError("CONFIGURATION_REQUIRED", "Checkbox settings must be boolean.", 400);
    } else {
      if (!["string", "number"].includes(typeof value) || String(value).length > 4096 || /[\r\n\0]/.test(String(value))) throw new SourceError("CONFIGURATION_REQUIRED", "A source setting is invalid.", 400);
      value = String(value).trim();
      if (field.type === "select" && value && field.options && !Object.hasOwn(field.options, value)) throw new SourceError("CONFIGURATION_REQUIRED", "Choose a valid source option.", 400);
    }
    return [field.name, value];
  }));
}

export function configurationComplete(definition, values) {
  return fields(definition).every((field) => !required(field, definition) || Boolean(values?.[field.name]));
}

export function requiresFlareSolverr(definition) {
  return fields(definition).some((field) => field.type === "info_flaresolverr");
}

function compatibility(definition) {
  const unsupported = [];
  const add = (feature, path, message) => unsupported.push({ feature, path, message });
  if (definition.login?.captcha) add("captcha", "definition.login.captcha", "CAPTCHA login is unsupported.");
  if (definition.certificates?.length) add("certificates", "definition.certificates", "Definition-specific certificate pinning is unsupported.");
  if (definition.testlinktorrent) add("testlinktorrent", "definition.testlinktorrent", "Torrent-link self-testing is unsupported.");
  if (!definitionCapabilities(definition).mediaTypes.length) add("media-types", "definition.caps", "Movie or TV categories are required.");
  try { new TextDecoder(definition.encoding); } catch { add("encoding", "definition.encoding", "Response encoding is unsupported."); }
  if (!definition.links.length) add("links", "definition.links", "At least one current link is required.");
  if (definition.search.paths?.length > 10) add("search-paths", "definition.search.paths", "A maximum of ten search paths is supported.");
  for (const name of ["case", "text"]) if (definition.search.rows[name] !== undefined) add("rows", `definition.search.rows.${name}`, "This row selection option is unsupported.");
  for (const [index, link] of definition.links.entries()) {
    try { endpointUrl(link, { protocols: ["http:", "https:"], base: true }); }
    catch { add("link", `definition.links[${index}]`, "Current links must be credential-free HTTP(S) base URLs."); }
  }
  function inspect(value, path, depth = 0) {
    if (depth > 40) throw new SourceError("CARDIGANN_INVALID", "The definition is too deeply nested.");
    if (typeof value === "string" && value.includes("{{")) {
      try { parseTemplate(value); } catch { add("template", path, "The template uses unsupported syntax."); }
    }
    if (typeof value === "string" && path.endsWith(".selector") && /\?\(|\(@/.test(value)) add("json-expression", path, "Executable JSONPath selectors are unsupported.");
    if (Array.isArray(value)) {
      if (/(?:filters|keywordsfilters|preprocessingfilters)$/.test(path)) {
        for (const [index, filter] of value.entries()) {
          const rowFilter = path.endsWith("search.rows.filters");
          if (rowFilter ? !["andmatch", "strdump", "hexdump"].includes(filter?.name) : !CARDIGANN_FILTERS.has(filter?.name)) {
            add("filter", `${path}[${index}]`, "The definition uses an unsupported filter.");
          }
          const args = Array.isArray(filter?.args) ? filter.args : [filter?.args];
          if (["regexp", "re_replace"].includes(filter?.name) && typeof args[0] === "string" && !args[0].includes("{{")) {
            try { validateRegex(args[0].replace(/^\(\?i\)/, "")); }
            catch { add("regexp", `${path}[${index}]`, "The regular expression uses unsupported syntax."); }
          }
          if (filter?.name === "jsonjoinarray" && typeof args[0] === "string" && /\?\(|\(@/.test(args[0])) {
            add("json-expression", `${path}[${index}]`, "Executable JSONPath expressions are unsupported.");
          }
        }
      }
      value.forEach((item, index) => inspect(item, `${path}[${index}]`, depth + 1));
    } else if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        if (["__proto__", "constructor", "prototype"].includes(key)) throw new SourceError("CARDIGANN_INVALID", "The definition contains unsafe fields.");
        inspect(item, `${path}.${key}`, depth + 1);
      }
    }
  }
  inspect(definition, "definition");
  return { schemaVersion: 11, supported: !unsupported.length, unsupportedFeatures: unsupported };
}

export function validateDefinitionObject(definition, { allowUnsupported = false } = {}) {
  if (!validate(definition)) throw new SourceError("CARDIGANN_INVALID", "The file is not a valid Cardigann v11 definition.");
  const result = { definition, capabilities: definitionCapabilities(definition), compatibility: compatibility(definition) };
  if (!result.compatibility.supported && !allowUnsupported) {
    throw Object.assign(new SourceError("CARDIGANN_UNSUPPORTED", "This definition requires unsupported Cardigann features."),
      { unsupportedFeatures: result.compatibility.unsupportedFeatures });
  }
  return result;
}

export function parseDefinition(source, options) {
  if (Buffer.byteLength(String(source)) > 256 * 1024) throw new SourceError("CARDIGANN_INVALID", "The definition is too large.");
  let definition;
  try {
    const document = parseDocument(String(source), { uniqueKeys: true, prettyErrors: false });
    if (document.errors.length) throw new Error();
    definition = document.toJS({ maxAliasCount: 50 });
  } catch { throw new SourceError("CARDIGANN_INVALID", "The definition contains invalid YAML."); }
  return validateDefinitionObject(definition, options);
}

function importedDefinitions() {
  const records = globalThis[importsKey] ??= new Map();
  for (const [id, record] of records) if (record.expiresAt <= Date.now()) records.delete(id);
  return records;
}

export function importedDefinition(id) {
  const record = importedDefinitions().get(id);
  if (!record) throw new SourceError("CARDIGANN_IMPORT_EXPIRED", "The definition import expired. Import it again.", 410);
  return record;
}

export function consumeImportedDefinition(id) { importedDefinitions().delete(id); }

export async function importDefinition(input, options = {}) {
  let url = endpointUrl(input, { base: true });
  if (url.hostname === "github.com") {
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[2] !== "blob" || parts.length < 5) throw new SourceError("CARDIGANN_URL_INVALID", "Choose an individual definition file.", 400);
    url = new URL(`https://raw.githubusercontent.com/${parts[0]}/${parts[1]}/${parts.slice(3).join("/")}`);
  }
  if (!/\.ya?ml$/i.test(url.pathname)) throw new SourceError("CARDIGANN_URL_INVALID", "Choose a YAML definition URL.", 400);
  const response = await (options.request || request)(url, { signal: options.signal, maxBytes: 256 * 1024, timeoutMs: 15_000 });
  if (response.status !== 200) throw new SourceError("SOURCE_UNAVAILABLE", "The definition could not be downloaded.", 502);
  const definitionYaml = response.body.toString("utf8");
  const parsed = parseDefinition(definitionYaml);
  const records = importedDefinitions();
  while (records.size >= 200) records.delete(records.keys().next().value);
  const id = randomUUID();
  records.set(id, { ...parsed, definitionYaml, sourceUrl: url.href,
    hash: createHash("sha256").update(definitionYaml).digest("hex"), expiresAt: Date.now() + 10 * 60_000 });
  return { importId: id, compatibility: parsed.compatibility, definition: {
    id: parsed.definition.id, name: parsed.definition.name, access: parsed.definition.type,
    language: parsed.definition.language, categories: parsed.capabilities.categories,
    sourceUrl: url.href, website: parsed.definition.links[0],
    settings: settingDescriptors(parsed.definition), requiresFlareSolverr: requiresFlareSolverr(parsed.definition),
  } };
}
