import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { SETTINGS_ENVIRONMENT_KEYS, SETTINGS_PROVIDERS, settingsProvider } from "./definitions.js";

const MAX_SECRET_LENGTH = 4096;
const MAX_TEXT_LENGTH = 2048;
let writeQueue = Promise.resolve();

export class SettingsError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "SettingsError";
    this.status = status;
  }
}

export function settingsConfigPath(environment = process.env, cwd = process.cwd()) {
  return path.resolve(/* turbopackIgnore: true */ environment.TORPLAY_CONFIG_PATH?.trim() || path.join(cwd, ".env.local"));
}

function unquote(value) {
  if (value.length >= 2 && value[0] === value.at(-1) && ["\"", "'"].includes(value[0])) {
    return value.slice(1, -1);
  }
  return value;
}

export function parseSettingsEnvironment(source = "") {
  const values = {};
  for (const line of String(source).split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (match) values[match[1]] = unquote(match[2].trim());
  }
  return values;
}

async function readConfigFile(filename) {
  try {
    return await readFile(filename, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw new SettingsError("TorPlay could not read its configuration file.", 500);
  }
}

function configuredValue(value) {
  const normalized = String(value || "").trim();
  return normalized && normalized !== "replace-me" ? normalized : "";
}

function externalKeySet(environment, fileValues) {
  const declared = String(environment.TORPLAY_EXTERNAL_CONFIG_KEYS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (declared.length) return new Set(declared);
  return new Set(SETTINGS_ENVIRONMENT_KEYS.filter((key) => (
    configuredValue(environment[key]) && configuredValue(environment[key]) !== configuredValue(fileValues[key])
  )));
}

function fieldValue(field, environment) {
  return configuredValue(environment[field.environment]) || field.defaultValue || "";
}

export async function settingsState({
  environment = process.env,
  cwd = process.cwd(),
  includeValues = false,
} = {}) {
  const filename = settingsConfigPath(environment, cwd);
  const source = await readConfigFile(filename);
  const fileValues = parseSettingsEnvironment(source);
  const external = externalKeySet(environment, fileValues);
  return {
    filename,
    providers: SETTINGS_PROVIDERS.map((provider) => {
      const fields = provider.fields.map((field) => {
        const value = fieldValue(field, environment);
        return {
          id: field.id,
          label: field.label,
          secret: Boolean(field.secret),
          required: Boolean(field.required),
          kind: field.kind || (field.secret ? "secret" : "text"),
          configured: Boolean(configuredValue(environment[field.environment])),
          managedExternally: external.has(field.environment),
          ...(includeValues && !field.secret ? { value } : {}),
        };
      });
      const requiredFields = provider.fields.filter((field) => field.required);
      const configured = requiredFields.length
        ? requiredFields.every((field) => Boolean(configuredValue(environment[field.environment]) || field.defaultValue))
        : provider.fields.some((field) => field.secret && Boolean(configuredValue(environment[field.environment])));
      return {
        id: provider.id,
        section: provider.section,
        name: provider.name,
        required: provider.required,
        description: provider.description,
        helpUrl: provider.helpUrl,
        helpText: provider.helpText,
        configured,
        fields,
      };
    }),
  };
}

function singleLine(value, field) {
  const normalized = String(value ?? "").trim();
  const limit = field.secret ? MAX_SECRET_LENGTH : MAX_TEXT_LENGTH;
  if (!normalized || normalized.length > limit || /[\r\n\0]/.test(normalized)) {
    throw new SettingsError(`${field.label} must be a non-empty single-line value no longer than ${limit} characters.`);
  }
  return normalized;
}

function validateField(field, value) {
  if (field.kind === "indexers" && String(value ?? "").trim() === "") return "";
  const normalized = singleLine(value, field);
  if (field.kind === "url") {
    let url;
    try {
      url = new URL(normalized);
    } catch {
      throw new SettingsError(`${field.label} must be a valid HTTP or HTTPS URL.`);
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      throw new SettingsError(`${field.label} must be an HTTP or HTTPS URL without embedded credentials.`);
    }
    return url.toString().replace(/\/$/, "");
  }
  if (field.kind === "indexers") {
    const values = [...new Set(normalized.split(",").map((item) => item.trim()).filter(Boolean))];
    if (values.some((item) => !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(item))) {
      throw new SettingsError(`${field.label} contains an invalid indexer ID.`);
    }
    return values.join(",");
  }
  if (field.kind === "userAgent" && !/^[\x20-\x7e]+$/.test(normalized)) {
    throw new SettingsError(`${field.label} must contain printable characters only.`);
  }
  if (field.id === "apiToken" && /^[a-f\d]{32}$/i.test(normalized)) {
    throw new SettingsError("TMDB requires the API Read Access Token, not the 32-character v3 API key.");
  }
  return normalized;
}

function encodedValue(value) {
  if (/^[A-Za-z0-9_./,:@+%=-]+$/.test(value)) return value;
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes("\"") && !value.includes("\\")) return `"${value}"`;
  throw new SettingsError("This value contains unsupported quote characters.");
}

function updateSource(source, updates, removals) {
  const remaining = new Map(Object.entries(updates));
  const lines = String(source).split(/\r?\n/).filter((line, index, values) => (
    index < values.length - 1 || line !== ""
  ));
  const output = [];
  for (const line of lines) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=/);
    const key = match?.[1];
    if (key && removals.has(key)) continue;
    if (key && remaining.has(key)) {
      output.push(`${key}=${encodedValue(remaining.get(key))}`);
      remaining.delete(key);
    } else {
      output.push(line);
    }
  }
  for (const [key, value] of remaining) output.push(`${key}=${encodedValue(value)}`);
  return output.length ? `${output.join("\n")}\n` : "";
}

async function atomicWrite(filename, contents, platform = process.platform) {
  const directory = path.dirname(filename);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(filename)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, filename);
    await chmod(filename, 0o600).catch((error) => {
      if (platform !== "win32") throw error;
    });
  } catch (error) {
    await unlink(temporary).catch(() => {});
    if (error instanceof SettingsError) throw error;
    throw new SettingsError("TorPlay could not save its configuration file.", 500);
  }
}

async function updateProviderNow(providerId, payload, options) {
  const provider = settingsProvider(providerId);
  if (!provider) throw new SettingsError("Unknown settings provider.");
  const values = payload?.values && typeof payload.values === "object" && !Array.isArray(payload.values)
    ? payload.values
    : {};
  const remove = Array.isArray(payload?.remove) ? payload.remove : [];
  const known = new Map(provider.fields.map((field) => [field.id, field]));
  const unknown = [...Object.keys(values), ...remove].find((id) => !known.has(id));
  if (unknown) throw new SettingsError("Settings contain an unknown field.");

  const environment = options.environment || process.env;
  const filename = options.configPath || settingsConfigPath(environment, options.cwd);
  const source = await readConfigFile(filename);
  const fileValues = parseSettingsEnvironment(source);
  const external = externalKeySet(environment, fileValues);
  const updates = {};
  const removals = new Set();

  for (const [id, rawValue] of Object.entries(values)) {
    const field = known.get(id);
    if (external.has(field.environment)) throw new SettingsError(`${field.label} is managed by the host environment.`, 409);
    if (field.secret && String(rawValue ?? "").trim() === "") continue;
    updates[field.environment] = validateField(field, rawValue);
  }
  for (const id of remove) {
    const field = known.get(id);
    if (external.has(field.environment)) throw new SettingsError(`${field.label} is managed by the host environment.`, 409);
    removals.add(field.environment);
  }
  if (!Object.keys(updates).length && !removals.size) throw new SettingsError("No settings changes were provided.");

  await atomicWrite(filename, updateSource(source, updates, removals), options.platform);
  for (const [key, value] of Object.entries(updates)) environment[key] = value;
  for (const key of removals) delete environment[key];
  return {
    providerId,
    restartRequired: providerId === "omdb",
  };
}

export function updateProviderSettings(providerId, payload, options = {}) {
  const operation = writeQueue.then(() => updateProviderNow(providerId, payload, options));
  writeQueue = operation.catch(() => {});
  return operation;
}

export async function configurationWritable({ environment = process.env, cwd = process.cwd() } = {}) {
  const filename = settingsConfigPath(environment, cwd);
  try {
    const details = await stat(/* turbopackIgnore: true */ filename);
    if (!details.isFile()) return false;
    await access(/* turbopackIgnore: true */ filename, constants.W_OK);
    return true;
  } catch (error) {
    if (error.code !== "ENOENT") return false;
    try {
      await access(/* turbopackIgnore: true */ path.dirname(filename), constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }
}
