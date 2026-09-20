import { load } from "cheerio";
import { JSONPath } from "jsonpath-plus";
import { CookieJar } from "tough-cookie";
import { applyFilters } from "./filters.js";
import { safeRequest } from "./http.js";
import { renderTemplate } from "./template.js";

function templateContext(context, config, result = {}, extra = {}) {
  const imdbId = String(context.imdbId || "");
  const imdbShort = imdbId.replace(/^tt/, "");
  const today = new Date();
  return {
    Config: config,
    Result: result,
    Keywords: context.title || context.query || "",
    Query: {
      Type: context.type === "show" ? "tvsearch" : context.type === "movie" ? "movie" : "search",
      Q: context.title || context.query || "",
      Keywords: context.title || context.query || "",
      Movie: context.title || context.query || "",
      Series: context.title || context.query || "",
      Season: context.season ?? "",
      Episode: context.episode ?? "",
      Ep: context.episode ?? "",
      IMDBID: imdbId,
      IMDBIDShort: imdbShort,
      TMDBID: context.tmdbId ?? "",
      TVDBID: context.tvdbId ?? "",
      TVMAZEID: context.tvmazeId ?? "",
      TRAKTID: context.traktId ?? "",
      DOUBANID: context.doubanId ?? "",
      Year: context.year ?? "",
    },
    ImdbID: imdbId,
    IMDBID: imdbId,
    TMDbID: context.tmdbId ?? "",
    Season: context.season ?? "",
    Episode: context.episode ?? "",
    Year: context.year ?? "",
    Today: { Year: today.getUTCFullYear(), Month: today.getUTCMonth() + 1, Day: today.getUTCDate() },
    Categories: extra.categories || [],
    DownloadUri: extra.downloadUri || {},
  };
}

function uriVariables(value) {
  const url = new URL(value);
  return {
    AbsoluteUri: url.toString(),
    AbsolutePath: url.pathname,
    Scheme: url.protocol.replace(/:$/, ""),
    Host: url.host,
    PathAndQuery: `${url.pathname}${url.search}`,
    Query: Object.fromEntries(url.searchParams),
  };
}

function absolute(value, base) {
  if (!value) return "";
  try { return new URL(String(value), base).toString(); } catch { return ""; }
}

function cookieHeaders(headers) {
  const value = headers["set-cookie"];
  return value ? Array.isArray(value) ? value : [value] : [];
}

function createSession(options = {}) {
  const jar = new CookieJar();
  const request = options.request || safeRequest;
  return {
    jar,
    async request(url, requestOptions = {}) {
      const headers = { "User-Agent": "TorPlay Cardigann/1.0", Accept: "text/html, application/json, application/xml, */*", ...requestOptions.headers };
      const cookies = await jar.getCookieString(url);
      if (cookies) headers.Cookie = cookies;
      const response = await request(url, {
        ...requestOptions,
        headers,
        protocols: ["http:", "https:"],
        requestImpl: options.requestImpl,
        onResponse: async (response) => {
          for (const cookie of cookieHeaders(response.headers)) await jar.setCookie(cookie, response.url.toString(), { ignoreError: true });
          const nextCookies = await jar.getCookieString(response.url.toString());
          if (nextCookies) headers.Cookie = nextCookies;
        },
      });
      for (const cookie of cookieHeaders(response.headers)) await jar.setCookie(cookie, response.url.toString(), { ignoreError: true });
      return response;
    },
  };
}

function renderedObject(object = {}, context) {
  return Object.fromEntries(Object.entries(object).map(([key, value]) => [key, Array.isArray(value)
    ? value.map((item) => renderTemplate(item, context))
    : renderTemplate(value, context)]));
}

function requestDetails(base, path, inputs, method = "get", headers = {}, querySeparator = "&", allowEmpty = true) {
  const url = new URL(path || "", base);
  const normalizedMethod = String(method || "get").toUpperCase();
  const parameters = new URLSearchParams();
  for (const [key, value] of Object.entries(inputs || {})) {
    if (key === "$raw") {
      for (const [rawKey, rawValue] of new URLSearchParams(String(value || ""))) {
        if (rawKey && (allowEmpty || rawValue !== "")) parameters.append(rawKey, rawValue);
      }
    } else if (allowEmpty || (value !== "" && value !== null && value !== undefined)) {
      parameters.append(key, String(value));
    }
  }
  if (normalizedMethod === "POST") {
    return { url: url.toString(), method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers }, body: parameters.toString() };
  }
  const query = parameters.toString();
  if (query) url.search = url.search ? `${url.search.slice(1)}${querySeparator}${query}` : query;
  return { url: url.toString(), method: "GET", headers };
}

function jsonPath(selector) {
  const value = String(selector || "$.").trim();
  return value.startsWith("$") ? value : `$.${value.replace(/^\./, "")}`;
}

function selectorValue(block, document, kind, context) {
  if (!block) return "";
  let value;
  if (block.text !== undefined) value = renderTemplate(block.text, context);
  else if (kind === "json") {
    const matches = JSONPath({ path: jsonPath(renderTemplate(block.selector || "$", context)), json: document, wrap: true });
    value = matches.length > 1 ? matches : matches[0];
  } else {
    const selector = block.selector ? renderTemplate(block.selector, context) : "";
    let selected = selector ? document.find(selector).first() : document;
    if (block.remove) { selected = selected.clone(); selected.find(renderTemplate(block.remove, context)).remove(); }
    if (block.case) {
      for (const [candidate, replacement] of Object.entries(block.case)) {
        if (candidate === "*" || selected.is(candidate) || selected.find(candidate).length) {
          value = renderTemplate(replacement, context);
          break;
        }
      }
    }
    if (value === undefined) value = block.attribute ? selected.attr(block.attribute) : selected.text();
  }
  if ((value === undefined || value === null || value === "") && block.default !== undefined) value = renderTemplate(block.default, context);
  if (kind === "json" && block.case && value !== undefined) {
    value = Object.hasOwn(block.case, String(value)) ? block.case[String(value)] : block.case["*"] ?? value;
    if (typeof value === "string") value = renderTemplate(value, context);
  }
  if ((value === undefined || value === null || value === "") && !block.optional && block.text === undefined) return "";
  return applyFilters(value, block.filters, { render: (item) => renderTemplate(item, context) });
}

function decodedText(body, encoding = "UTF-8") {
  return new TextDecoder(encoding).decode(body);
}

function responseDocument(body, responseType, encoding) {
  const text = decodedText(body, encoding);
  if (responseType === "json") return { kind: "json", document: JSON.parse(text), text };
  const xml = responseType === "xml";
  return { kind: xml ? "xml" : "html", document: load(text, { xmlMode: xml }), text };
}

function rowsFrom(parsed, rows, context) {
  if (parsed.kind === "json") {
    const selected = JSONPath({ path: jsonPath(renderTemplate(rows.selector || "$", context)), json: parsed.document, wrap: true }).flat();
    const expanded = [];
    for (const row of selected) {
      const attribute = rows.attribute ? renderTemplate(rows.attribute, context) : null;
      const nested = attribute ? row?.[attribute] : row;
      if (nested === undefined || nested === null) {
        if (rows.missingAttributeEqualsNoResults) return [];
        continue;
      }
      if (rows.multiple && Array.isArray(nested)) expanded.push(...nested);
      else expanded.push(nested);
    }
    return expanded.slice(rows.after || 0);
  }
  const selected = rows.selector ? parsed.document(renderTemplate(rows.selector, context)) : parsed.document.root().children();
  return selected.toArray().slice(rows.after || 0).map((element) => parsed.document(element));
}

function sizeBytes(value) {
  if (typeof value === "number") return Math.max(0, Math.floor(value));
  const match = String(value || "").replaceAll(",", "").match(/([\d.]+)\s*([kmgtpe]?i?b)?/i);
  if (!match) return 0;
  const powers = { b: 0, kb: 1, kib: 1, mb: 2, mib: 2, gb: 3, gib: 3, tb: 4, tib: 4, pb: 5, pib: 5 };
  return Math.max(0, Math.floor(Number(match[1]) * 1024 ** (powers[(match[2] || "b").toLowerCase()] ?? 0)));
}

function count(value) {
  const number = Number(String(value || "0").replace(/[^\d-]/g, ""));
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function delay(milliseconds, signal) {
  if (!milliseconds) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, Math.min(Math.max(Number(milliseconds), 0), 30_000));
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason || new Error("Search cancelled."));
    }, { once: true });
  });
}

function pageError(errors, parsed, context) {
  for (const error of errors || []) {
    if (error.path) continue;
    const selected = parsed.kind === "json"
      ? JSONPath({ path: error.selector, json: parsed.document, wrap: true })
      : parsed.document(error.selector).toArray();
    if (!selected.length) continue;
    const message = error.message ? selectorValue(error.message, parsed.kind === "json" ? parsed.document : parsed.document.root(), parsed.kind, context) : "";
    return String(message || "The indexer rejected the request.");
  }
  return null;
}

async function searchPageError(errors, parsed, context, session, base, definition, signal) {
  const local = pageError(errors, parsed, context);
  if (local) return local;
  for (const error of errors || []) {
    if (!error.path) continue;
    const url = new URL(renderTemplate(error.path, context), base);
    const response = await session.request(url, { signal, maxBytes: 5 * 1024 * 1024 });
    if (response.status < 200 || response.status >= 400) continue;
    const errorPage = responseDocument(response.body, "html", definition.encoding);
    const message = pageError([{ ...error, path: undefined }], errorPage, context);
    if (message) return message;
  }
  return null;
}

function dateHeaderValue(row, rows, context) {
  if (!rows.dateheaders || typeof row?.prevAll !== "function") return "";
  const selector = renderTemplate(rows.dateheaders.selector || "", context);
  if (!selector) return "";
  let header = row.prevAll(selector).first();
  if (!header.length) header = row.prevAll().find(selector).first();
  return header.length ? selectorValue({ ...rows.dateheaders, selector: undefined }, header, "html", context) : "";
}

function categoriesFor(definition, type) {
  const prefix = type === "show" ? "TV" : "Movies";
  const ids = [];
  for (const [id, name] of Object.entries(definition.caps.categories || {})) if (String(name) === prefix || String(name).startsWith(`${prefix}/`)) ids.push(id);
  for (const mapping of definition.caps.categorymappings || []) if (mapping.cat === prefix || String(mapping.cat).startsWith(`${prefix}/`)) ids.push(String(mapping.id));
  return [...new Set(ids)];
}

function categoriesForPath(categories, pathCategories = []) {
  if (!pathCategories.length || !categories.length) return categories;
  const excluded = new Set(pathCategories.filter((item) => String(item).startsWith("!")).map((item) => String(item).slice(1)));
  const included = pathCategories.filter((item) => !String(item).startsWith("!")).map(String);
  if (categories.some((item) => excluded.has(String(item)))) return null;
  if (!included.length) return categories;
  const selected = categories.filter((item) => included.includes(String(item)));
  return selected.length ? selected : null;
}

async function ensureLogin(definition, config, session, base, context) {
  const login = definition.login;
  if (!login) return;
  const effectiveConfig = { sitelink: base, ...config };
  const template = templateContext(context, effectiveConfig);
  for (const cookieTemplate of login.cookies || []) {
    const value = renderTemplate(cookieTemplate, template);
    if (value) await session.jar.setCookie(value, base);
  }
  const method = login.method || "form";
  if (method === "cookie") {
    const cookieTemplate = login.inputs?.cookie ?? effectiveConfig.cookie ?? effectiveConfig.cookies;
    const cookie = renderTemplate(cookieTemplate || "", template);
    if (!cookie) throw new Error("The indexer cookie is required.");
    for (const pair of String(cookie).split(";").map((item) => item.trim()).filter(Boolean)) await session.jar.setCookie(pair, base);
    if (login.test?.path) {
      const verification = await session.request(new URL(renderTemplate(login.test.path, template), base), { signal: context.signal, maxBytes: 5 * 1024 * 1024 });
      if (verification.status < 200 || verification.status >= 400) throw new Error("Indexer login could not be verified.");
      const $ = load(decodedText(verification.body, definition.encoding));
      if (login.test.selector && !$(login.test.selector).length) throw new Error("Indexer login could not be verified.");
    }
    return;
  }
  let path = renderTemplate(login.path || "", template);
  let inputs = renderedObject(login.inputs, template);
  if (method === "oneurl") {
    path += inputs.oneurl || "";
    inputs = {};
  }
  if (method === "form") {
    const page = await session.request(new URL(path, base), { signal: context.signal, maxBytes: 5 * 1024 * 1024 });
    if (page.status < 200 || page.status >= 400) throw new Error("Indexer login page could not be loaded.");
    const $ = load(decodedText(page.body, definition.encoding));
    const form = $(login.form || "form").first();
    if (!form.length) throw new Error("Indexer login form could not be found.");
    const hidden = {};
    form.find("input[name]").each((_index, element) => { hidden[$(element).attr("name")] = $(element).attr("value") || ""; });
    const configured = {};
    for (const [name, value] of Object.entries(inputs)) {
      if (login.selectors) {
        const fieldName = form.find(name).first().attr("name");
        if (!fieldName) throw new Error(`Indexer login input could not be found: ${name}.`);
        configured[fieldName] = value;
      } else configured[name] = value;
    }
    for (const [name, selector] of Object.entries(login.selectorinputs || {})) configured[name] = selectorValue(selector, form, "html", template);
    for (const [name, selector] of Object.entries(login.getselectorinputs || {})) configured[name] = selectorValue(selector, $.root(), "html", template);
    inputs = { ...hidden, ...configured };
    path = login.submitpath || form.attr("action") || path;
  }
  const requestMethod = method === "get" || method === "oneurl" ? "get" : "post";
  const details = requestDetails(base, renderTemplate(path, template), inputs, requestMethod, renderedObject(login.headers, template));
  const response = await session.request(details.url, { ...details, signal: context.signal, maxBytes: 5 * 1024 * 1024 });
  if (response.status < 200 || response.status >= 400) throw new Error("Indexer login failed.");
  for (const error of login.error || []) {
    const errorResponse = error.path
      ? await session.request(new URL(renderTemplate(error.path, template), base), { signal: context.signal, maxBytes: 5 * 1024 * 1024 })
      : response;
    const loginPage = load(decodedText(errorResponse.body, definition.encoding));
    const selected = loginPage(error.selector).first();
    if (selected.length) {
      const message = error.message
        ? selectorValue(error.message, loginPage.root(), "html", template)
        : selected.text();
      throw new Error(String(message || "Indexer login was rejected.").trim());
    }
  }
  let verification = response;
  if (login.test?.path) {
    const testUrl = new URL(renderTemplate(login.test.path, template), base);
    verification = await session.request(testUrl, { signal: context.signal, maxBytes: 5 * 1024 * 1024 });
    if (verification.status < 200 || verification.status >= 400) throw new Error("Indexer login could not be verified.");
  }
  const $ = load(decodedText(verification.body, definition.encoding));
  if (login.test?.selector && !$(login.test.selector).length) throw new Error("Indexer login could not be verified.");
}

async function resolveDownload(definition, config, session, base, rawUrl, result, signal) {
  const effectiveConfig = { sitelink: base, ...config };
  let context = templateContext({}, effectiveConfig, result);
  let url = absolute(renderTemplate(rawUrl, context), base);
  if (!url) throw new Error("The indexer returned an invalid download URL.");
  context = templateContext({}, effectiveConfig, result, { downloadUri: uriVariables(url) });
  const download = definition.download;
  const headers = renderedObject(download?.headers, context);
  const requestDownload = async (target, method = download?.method || "get", extra = {}) => {
    const response = await session.request(target, {
      signal,
      method: String(method).toUpperCase(),
      headers,
      maxBytes: 5 * 1024 * 1024,
      ...extra,
    });
    if (response.status < 200 || response.status >= 300) throw new Error("The indexer download failed.");
    return response;
  };
  let response;
  let beforeResponse;
  if (download?.before) {
    let beforePath = download.before.path;
    if (download.before.pathselector) {
      response = await requestDownload(url);
      const page = load(decodedText(response.body, definition.encoding));
      beforePath = selectorValue(download.before.pathselector, page.root(), "html", context);
    }
    if (!beforePath) throw new Error("The Cardigann download preparation did not produce a URL.");
    const details = requestDetails(
      base,
      renderTemplate(beforePath, context),
      renderedObject(download.before.inputs, context),
      download.before.method || "get",
      headers,
      download.before.queryseparator || "&",
    );
    beforeResponse = await requestDownload(details.url, details.method, { body: details.body, headers: details.headers });
  }
  const getResponse = async (useBefore = false) => {
    if (useBefore && beforeResponse) return beforeResponse;
    response ||= await requestDownload(url);
    return response;
  };
  const direct = await getResponse(false);
  const directType = String(direct.headers["content-type"] || "");
  if (/bittorrent|octet-stream/i.test(directType) || direct.body[0] === 100) return { torrentInput: direct.body };
  const directText = decodedText(direct.body, definition.encoding);
  const magnet = directText.match(/magnet:\?[^\s"'<>]+/i)?.[0];
  if (!download) {
    if (magnet) return { magnet: magnet.replaceAll("&amp;", "&") };
    return { torrentInput: direct.body };
  }
  const selectors = Array.isArray(definition.download.selectors) ? definition.download.selectors : [];
  for (const selector of selectors) {
    const selectorResponse = await getResponse(selector.usebeforeresponse === true);
    const page = load(decodedText(selectorResponse.body, definition.encoding));
    const value = selectorValue(selector, page.root(), "html", context);
    if (!value) continue;
    if (String(value).startsWith("magnet:")) return { magnet: String(value) };
    url = absolute(value, selectorResponse.url);
    if (url) {
      const downloaded = await requestDownload(url);
      const foundMagnet = decodedText(downloaded.body, definition.encoding).match(/magnet:\?[^\s"'<>]+/i)?.[0];
      if (foundMagnet) return { magnet: foundMagnet.replaceAll("&amp;", "&") };
      return { torrentInput: downloaded.body };
    }
  }
  if (download.infohash) {
    const hashResponse = await getResponse(download.infohash.usebeforeresponse === true);
    const page = load(decodedText(hashResponse.body, definition.encoding));
    const hash = selectorValue(download.infohash.hash, page.root(), "html", context);
    const title = selectorValue(download.infohash.title, page.root(), "html", context);
    if (/^[a-f\d]{40}$/i.test(hash)) return { magnet: `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(title || result.title || "")}` };
  }
  if (magnet) return { magnet: magnet.replaceAll("&amp;", "&") };
  throw new Error("The Cardigann download block did not produce torrent metadata.");
}

export function cardigannAdapter(provider, options = {}) {
  return {
    id: provider.id,
    name: provider.name,
    async search(context, { signal } = {}) {
      if (context.type !== "generic" && !provider.capabilities.mediaTypes.includes(context.type === "show" ? "TV" : "Movies")) return [];
      const definition = provider.definition;
      const base = definition.links[0];
      if (!base) throw new Error("Cardigann definition has no indexer URL.");
      const config = { sitelink: base, ...(provider.settings || {}) };
      const session = createSession(options);
      await ensureLogin(definition, config, session, base, { ...context, signal });
      const categories = context.type === "generic" ? [] : categoriesFor(definition, context.type);
      const template = templateContext(context, config, {}, { categories });
      let keywords = applyFilters(template.Keywords, definition.search.keywordsfilters, {
        render: (value) => renderTemplate(value, template),
      });
      template.Keywords = keywords;
      template.Query.Q = keywords;
      template.Query.Keywords = keywords;
      const paths = definition.search.paths || [{ path: definition.search.path }];
      const candidates = [];
      for (const [pathIndex, path] of paths.slice(0, 10).entries()) {
        if (pathIndex) await delay(Number(definition.requestDelay || 0) * 1000, signal);
        const pathCategories = categoriesForPath(categories, path.categories);
        if (pathCategories === null) continue;
        const pathTemplate = { ...template, Categories: pathCategories };
        const inputs = renderedObject({ ...(path.inheritinputs === false ? {} : definition.search.inputs), ...path.inputs }, pathTemplate);
        const headers = renderedObject(definition.search.headers, pathTemplate);
        const details = requestDetails(base, renderTemplate(path.path, pathTemplate), inputs, path.method || "get", headers, path.queryseparator || "&", definition.search.allowEmptyInputs === true);
        const followRedirect = path.followredirect ?? definition.followredirect;
        const response = await session.request(details.url, { ...details, signal, maxBytes: 5 * 1024 * 1024, maxRedirects: followRedirect === false ? 0 : undefined });
        if (response.status < 200 || response.status >= 400) throw new Error(`Indexer search returned HTTP ${response.status}.`);
        let body = response.body;
        const responseText = decodedText(body, definition.encoding);
        if (path.response?.noResultsMessage && responseText.includes(path.response.noResultsMessage)) continue;
        if (definition.search.preprocessingfilters?.length) {
          body = Buffer.from(String(applyFilters(responseText, definition.search.preprocessingfilters, {
            render: (value) => renderTemplate(value, pathTemplate),
          })));
        }
        const parsed = responseDocument(body, path.response?.type, definition.search.preprocessingfilters?.length ? "UTF-8" : definition.encoding);
        const searchError = await searchPageError(definition.search.error, parsed, pathTemplate, session, base, definition, signal);
        if (searchError) throw new Error(searchError);
        if (definition.search.rows.count) {
          const rowCount = selectorValue(definition.search.rows.count, parsed.kind === "json" ? parsed.document : parsed.document.root(), parsed.kind, pathTemplate);
          if (count(rowCount) === 0) continue;
        }
        const rows = rowsFrom(parsed, definition.search.rows, pathTemplate);
        for (const row of rows) {
          if (candidates.length >= 200) break;
          const result = {};
          for (const [field, selector] of Object.entries(definition.search.fields)) {
            const [rawField, appendMode] = field.split("|");
            const fieldName = rawField.startsWith("_") ? rawField : rawField.replace(/_[A-Za-z0-9_]+$/, "");
            const resultTemplate = templateContext(context, config, result, { categories: pathCategories });
            const value = selectorValue(selector, row, parsed.kind, resultTemplate);
            if (value !== "") result[fieldName] = appendMode === "noappend" ? value : result[fieldName] ? `${result[fieldName]}${value}` : value;
          }
          if (!result.date) result.date = dateHeaderValue(row, definition.search.rows, templateContext(context, config, result, { categories: pathCategories }));
          if (!result.title) continue;
          if (definition.search.rows.filters?.some((filter) => filter.name === "andmatch")) {
            const words = keywords.toLowerCase().split(/\s+/).filter(Boolean);
            if (!words.every((word) => String(result.title).toLowerCase().includes(word))) continue;
          }
          const magnet = String(result.magnet || result.download || "").startsWith("magnet:") ? String(result.magnet || result.download) : null;
          const download = magnet ? null : absolute(result.download || result.details, response.url);
          const resolver = download ? () => resolveDownload(definition, config, session, base, download, result, signal) : null;
          const imdbId = String(result.imdbid || result.imdb || "").replace(/^tt/, "");
          candidates.push({
            title: String(result.title),
            indexer: provider.name,
            size: sizeBytes(result.size),
            seeders: count(result.seeders),
            leechers: count(result.leechers),
            infoHash: String(result.infohash || "") || null,
            media: {
              type: context.type === "show" ? "show" : context.type === "movie" ? "movie" : null,
              imdbId: /^\d+$/.test(imdbId) ? `tt${imdbId}` : null,
              tmdbId: count(result.tmdbid) || null,
              year: count(result.year) || null,
            },
            source: { magnet, downloadUrl: definition.download ? null : download, resolver },
          });
        }
      }
      return candidates;
    },
  };
}

export async function testCardigannProvider(provider, options = {}) {
  const adapter = cardigannAdapter(provider, options);
  await adapter.search({ title: "Sintel", type: provider.capabilities.mediaTypes.includes("Movies") ? "movie" : "show", season: 1, episode: 1 }, {});
  return provider.capabilities;
}
