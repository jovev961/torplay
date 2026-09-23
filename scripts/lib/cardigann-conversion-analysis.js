import { CARDIGANN_FILTERS } from "../../lib/search/cardigann/filters.js";

export const CONVERSION_MODEL_VERSION = 1;

const SIMPLE_RESPONSE_TYPES = new Set(["html", "json"]);
const SIMPLE_SETTING_TYPES = new Set(["checkbox", "info", "select", "text", "password"]);
const SIMPLE_FIELD_OPTIONS = new Set(["selector", "attribute", "text", "default", "optional", "filters"]);
const SIMPLE_ROW_OPTIONS = new Set(["selector", "attribute", "after"]);
const SIMPLE_PATH_OPTIONS = new Set(["path", "method", "inputs", "response"]);
const SIMPLE_RESPONSE_OPTIONS = new Set(["type"]);
const SIMPLE_SEARCH_OPTIONS = new Set(["path", "paths", "inputs", "keywordsfilters", "rows", "fields"]);

function visit(value, callback, path = "definition") {
  callback(value, path);
  if (Array.isArray(value)) {
    value.forEach((item, index) => visit(item, callback, `${path}[${index}]`));
  } else if (value && typeof value === "object") {
    Object.entries(value).forEach(([key, item]) => visit(item, callback, `${path}.${key}`));
  }
}

function templates(value) {
  return String(value).match(/\{\{[\s\S]*?\}\}/g) || [];
}

function simpleReference(template) {
  const directive = template.slice(2, -2).trim();
  return /^\.(?:Keywords|Categories|Config(?:\.[A-Za-z0-9_]+)+|Query(?:\.[A-Za-z0-9_]+)+|Result(?:\.[A-Za-z0-9_]+)+|Today(?:\.[A-Za-z0-9_]+)+|ImdbID|IMDBID|TMDbID|Season|Episode|Year)$/.test(directive);
}

export function analyzeCardigannConversion(definition) {
  const blockers = [];
  const add = (feature, path, message) => {
    if (!blockers.some((item) => item.feature === feature && item.path === path)) {
      blockers.push({ feature, path, message });
    }
  };

  if (definition.type !== "public") {
    add("access", "definition.type", "Only public definitions fit the minimal source model.");
  }
  if (definition.login) {
    add("login", "definition.login", "Login, cookie, and authenticated session flows require the Cardigann runtime.");
  }
  if (definition.download) {
    add("download", "definition.download", "Chained or selector-based downloads require the Cardigann runtime.");
  }
  if (definition.requestDelay !== undefined) {
    add("request-delay", "definition.requestDelay", "Delayed multi-request behavior requires the Cardigann runtime.");
  }
  if (definition.followredirect === false) {
    add("redirect-policy", "definition.followredirect", "Definition-specific redirect behavior requires the Cardigann runtime.");
  }
  if (String(definition.encoding || "UTF-8").toUpperCase() !== "UTF-8") {
    add("encoding", "definition.encoding", "The minimal source model supports UTF-8 responses only.");
  }

  const settings = Array.isArray(definition.settings) ? definition.settings : [];
  settings.forEach((setting, index) => {
    if (!SIMPLE_SETTING_TYPES.has(setting?.type)) {
      add("setting", `definition.settings[${index}].type`, `The ${setting?.type || "unknown"} setting type is outside the minimal source model.`);
    }
  });

  const search = definition.search || {};
  Object.keys(search).forEach((key) => {
    if (!SIMPLE_SEARCH_OPTIONS.has(key)) {
      add("search-option", `definition.search.${key}`, `The ${key} search option requires Cardigann runtime behavior.`);
    }
  });
  if (Object.hasOwn(search.inputs || {}, "$raw")) {
    add("raw-inputs", "definition.search.inputs.$raw", "Raw query-string construction requires the Cardigann runtime.");
  }

  const paths = Array.isArray(search.paths)
    ? search.paths
    : search.path !== undefined ? [{ path: search.path }] : [];
  if (paths.length !== 1) {
    add("search-paths", "definition.search.paths", "The minimal source model supports exactly one search path.");
  }
  paths.forEach((path, index) => {
    const location = Array.isArray(search.paths) ? `definition.search.paths[${index}]` : "definition.search";
    const pathBlock = path && typeof path === "object" ? path : { path };
    Object.keys(pathBlock).forEach((key) => {
      if (!SIMPLE_PATH_OPTIONS.has(key)) {
        add("path-option", `${location}.${key}`, `The ${key} path option requires Cardigann runtime behavior.`);
      }
    });
    const method = String(pathBlock.method || "get").trim();
    if (method.includes("{{")) {
      add("dynamic-method", `${location}.method`, "Templated request methods require the Cardigann runtime.");
    } else if (method.toLowerCase() !== "get") {
      add("method", `${location}.method`, "The minimal source model supports GET requests only.");
    }
    const response = pathBlock.response || {};
    if (Object.hasOwn(pathBlock.inputs || {}, "$raw")) {
      add("raw-inputs", `${location}.inputs.$raw`, "Raw query-string construction requires the Cardigann runtime.");
    }
    Object.keys(response).forEach((key) => {
      if (!SIMPLE_RESPONSE_OPTIONS.has(key)) {
        add("response-option", `${location}.response.${key}`, `The ${key} response option requires Cardigann runtime behavior.`);
      }
    });
    const responseType = String(response.type || "html").toLowerCase();
    if (!SIMPLE_RESPONSE_TYPES.has(responseType)) {
      add("response-type", `${location}.response.type`, `The ${responseType} response type is outside the minimal source model.`);
    }
  });

  const rows = search.rows || {};
  Object.keys(rows).forEach((key) => {
    if (!SIMPLE_ROW_OPTIONS.has(key)) {
      add("row-option", `definition.search.rows.${key}`, `The ${key} row option requires Cardigann runtime behavior.`);
    }
  });
  for (const [field, selector] of Object.entries(search.fields || {})) {
    if (!selector || typeof selector !== "object" || Array.isArray(selector)) {
      add("field", `definition.search.fields.${field}`, "Field extraction must use a declarative selector object.");
      continue;
    }
    Object.keys(selector).forEach((key) => {
      if (!SIMPLE_FIELD_OPTIONS.has(key)) {
        add("field-option", `definition.search.fields.${field}.${key}`, `The ${key} field option requires Cardigann runtime behavior.`);
      }
    });
  }

  visit(definition, (value, path) => {
    if (typeof value === "string" && value.includes("{{")) {
      for (const template of templates(value)) {
        if (!simpleReference(template)) {
          add("template", path, `The template expression ${template} requires the Cardigann runtime.`);
        }
      }
    }
    if (Array.isArray(value) && /(?:filters|keywordsfilters)$/.test(path)) {
      value.forEach((filter, index) => {
        if (!CARDIGANN_FILTERS.has(filter?.name)) {
          add("filter", `${path}[${index}]`, `The ${filter?.name || "unknown"} transform is outside the minimal source model.`);
        }
      });
    }
  });

  const responseTypes = [...new Set(paths.map((path) => String(path?.response?.type || "html").toLowerCase()))];
  return {
    modelVersion: CONVERSION_MODEL_VERSION,
    convertible: blockers.length === 0,
    responseTypes,
    blockers,
  };
}

export function summarizeConversionAnalysis(definitions) {
  const blockerDefinitions = {};
  const responseTypes = {};
  let convertible = 0;
  for (const { analysis } of definitions) {
    if (analysis.convertible) convertible += 1;
    for (const type of analysis.responseTypes) responseTypes[type] = (responseTypes[type] || 0) + 1;
    for (const feature of new Set(analysis.blockers.map((item) => item.feature))) {
      blockerDefinitions[feature] = (blockerDefinitions[feature] || 0) + 1;
    }
  }
  return {
    modelVersion: CONVERSION_MODEL_VERSION,
    analyzed: definitions.length,
    convertible,
    incompatible: definitions.length - convertible,
    responseTypes,
    blockerDefinitions,
  };
}
