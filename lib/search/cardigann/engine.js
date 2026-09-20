import { load } from "cheerio";
import { JSONPath } from "jsonpath-plus";
import { CookieJar } from "tough-cookie";
import { applyFilters } from "./filters.js";
import { safeRequest } from "./http.js";
import { renderTemplate } from "./template.js";

function templateContext(context, config, result = {}) {
  const imdb = String(context.imdbId || "").replace(/^tt/, "");
  const today = new Date();
  return {
    Config: config,
    Result: result,
    Keywords: context.title || context.query || "",
    Query: {
      Type: context.type === "show" ? "tv-search" : context.type === "movie" ? "movie-search" : "search",
      Q: context.title || context.query || "",
      Season: context.season ?? "",
      Episode: context.episode ?? "",
      IMDBID: imdb,
      TMDBID: context.tmdbId ?? "",
    },
    ImdbID: imdb,
    IMDBID: imdb,
    TMDbID: context.tmdbId ?? "",
    Season: context.season ?? "",
    Episode: context.episode ?? "",
    Year: context.year ?? "",
    Today: { Year: today.getUTCFullYear(), Month: today.getUTCMonth() + 1, Day: today.getUTCDate() },
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
      return request(url, {
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
    if (allowEmpty || (value !== "" && value !== null && value !== undefined)) parameters.append(key, String(value));
  }
  if (normalizedMethod === "POST") {
    return { url: url.toString(), method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers }, body: parameters.toString() };
  }
  const query = parameters.toString();
  if (query) url.search = url.search ? `${url.search.slice(1)}${querySeparator}${query}` : query;
  return { url: url.toString(), method: "GET", headers };
}

function selectorValue(block, document, kind, context) {
  if (!block) return "";
  let value;
  if (block.text !== undefined) value = renderTemplate(block.text, context);
  else if (kind === "json") {
    const matches = JSONPath({ path: block.selector || "$", json: document, wrap: true });
    value = matches.length > 1 ? matches : matches[0];
  } else {
    let selected = block.selector ? document.find(block.selector).first() : document;
    if (block.remove) { selected = selected.clone(); selected.find(block.remove).remove(); }
    value = block.attribute ? selected.attr(block.attribute) : selected.text();
  }
  if ((value === undefined || value === null || value === "") && block.default !== undefined) value = renderTemplate(block.default, context);
  if (block.case && value !== undefined && Object.hasOwn(block.case, String(value))) value = block.case[String(value)];
  if ((value === undefined || value === null || value === "") && !block.optional && block.text === undefined) return "";
  return applyFilters(value, block.filters, {});
}

function responseDocument(body, responseType) {
  const text = body.toString("utf8");
  if (responseType === "json") return { kind: "json", document: JSON.parse(text), text };
  const xml = responseType === "xml";
  return { kind: xml ? "xml" : "html", document: load(text, { xmlMode: xml }), text };
}

function rowsFrom(parsed, rows) {
  if (parsed.kind === "json") return JSONPath({ path: rows.selector || "$", json: parsed.document, wrap: true }).flat();
  const selected = rows.selector ? parsed.document(rows.selector) : parsed.document.root().children();
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

function categoriesFor(definition, type) {
  const prefix = type === "show" ? "TV" : "Movies";
  const ids = [];
  for (const [id, name] of Object.entries(definition.caps.categories || {})) if (String(name) === prefix || String(name).startsWith(`${prefix}/`)) ids.push(id);
  for (const mapping of definition.caps.categorymappings || []) if (mapping.cat === prefix || String(mapping.cat).startsWith(`${prefix}/`)) ids.push(String(mapping.id));
  return [...new Set(ids)];
}

async function ensureLogin(definition, config, session, base, context) {
  const login = definition.login;
  if (!login) return;
  const template = templateContext(context, config);
  for (const cookieName of login.cookies || []) {
    const value = config[cookieName];
    if (value) await session.jar.setCookie(`${cookieName}=${value}`, base);
  }
  if (login.method === "cookie") {
    const cookie = config.cookie || config.cookies;
    if (!cookie) throw new Error("The indexer cookie is required.");
    for (const pair of String(cookie).split(";").map((item) => item.trim()).filter(Boolean)) await session.jar.setCookie(pair, base);
    return;
  }
  let path = renderTemplate(login.path || "", template);
  let inputs = renderedObject(login.inputs, template);
  if (login.method === "form") {
    const page = await session.request(new URL(path, base), { signal: context.signal, maxBytes: 5 * 1024 * 1024 });
    if (page.status < 200 || page.status >= 400) throw new Error("Indexer login page could not be loaded.");
    const $ = load(page.body.toString("utf8"));
    const form = $(login.form || "form").first();
    const hidden = {};
    form.find("input[name]").each((_index, element) => { hidden[$(element).attr("name")] = $(element).attr("value") || ""; });
    for (const [name, selector] of Object.entries(login.selectorinputs || {})) hidden[name] = selectorValue(selector, form, "html", template);
    inputs = { ...hidden, ...inputs };
    path = login.submitpath || form.attr("action") || path;
  }
  const method = login.method === "get" || login.method === "oneurl" ? "get" : "post";
  const details = requestDetails(base, renderTemplate(path, template), inputs, method, renderedObject(login.headers, template));
  const response = await session.request(details.url, { ...details, signal: context.signal, maxBytes: 5 * 1024 * 1024 });
  if (response.status < 200 || response.status >= 400) throw new Error("Indexer login failed.");
  const loginPage = load(response.body.toString("utf8"));
  if (login.error?.some((error) => loginPage(error.selector).length)) throw new Error("Indexer login was rejected.");
  let verification = response;
  if (login.test?.path) {
    const testUrl = new URL(renderTemplate(login.test.path, template), base);
    verification = await session.request(testUrl, { signal: context.signal, maxBytes: 5 * 1024 * 1024 });
    if (verification.status < 200 || verification.status >= 400) throw new Error("Indexer login could not be verified.");
  }
  const $ = load(verification.body.toString("utf8"));
  if (login.test?.selector && !$(login.test.selector).length) throw new Error("Indexer login could not be verified.");
}

async function resolveDownload(definition, config, session, base, rawUrl, result, signal) {
  const context = templateContext({}, config, result);
  let url = absolute(renderTemplate(rawUrl, context), base);
  if (!url) throw new Error("The indexer returned an invalid download URL.");
  const method = String(definition.download?.method || "get").toUpperCase();
  const headers = renderedObject(definition.download?.headers, context);
  const response = await session.request(url, { signal, method, headers, maxBytes: 5 * 1024 * 1024 });
  if (response.status < 200 || response.status >= 300) throw new Error("The indexer download failed.");
  const contentType = String(response.headers["content-type"] || "");
  if (/bittorrent|octet-stream/i.test(contentType) || response.body[0] === 100) return { torrentInput: response.body };
  const text = response.body.toString("utf8");
  const magnet = text.match(/magnet:\?[^\s"'<>]+/i)?.[0];
  if (!definition.download) {
    if (magnet) return { magnet: magnet.replaceAll("&amp;", "&") };
    return { torrentInput: response.body };
  }
  const $ = load(text);
  const selectors = Array.isArray(definition.download.selectors) ? definition.download.selectors : [];
  for (const selector of selectors) {
    const value = selectorValue(selector, $.root(), "html", context);
    if (!value) continue;
    if (String(value).startsWith("magnet:")) return { magnet: String(value) };
    url = absolute(value, response.url);
    if (url) {
      const downloaded = await session.request(url, { signal, maxBytes: 5 * 1024 * 1024 });
      if (downloaded.status >= 200 && downloaded.status < 300) return { torrentInput: downloaded.body };
    }
  }
  if (definition.download.infohash) {
    const hash = selectorValue(definition.download.infohash.hash, $.root(), "html", context);
    const title = selectorValue(definition.download.infohash.title, $.root(), "html", context);
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
      const config = provider.settings || {};
      const base = definition.links[0];
      if (!base) throw new Error("Cardigann definition has no indexer URL.");
      const session = createSession(options);
      await ensureLogin(definition, config, session, base, { ...context, signal });
      const template = templateContext(context, config);
      let keywords = template.Keywords;
      keywords = applyFilters(keywords, definition.search.keywordsfilters);
      template.Keywords = keywords;
      template.Query.Q = keywords;
      const paths = definition.search.paths || [{ path: definition.search.path }];
      const categories = context.type === "generic" ? [] : categoriesFor(definition, context.type);
      const candidates = [];
      for (const [pathIndex, path] of paths.slice(0, 10).entries()) {
        if (pathIndex) await delay(definition.requestDelay, signal);
        if (path.categories?.length && categories.length && !path.categories.some((item) => categories.includes(String(item)))) continue;
        const inputs = renderedObject({ ...(path.inheritinputs === false ? {} : definition.search.inputs), ...path.inputs }, template);
        const headers = renderedObject(definition.search.headers, template);
        const details = requestDetails(base, renderTemplate(path.path, template), inputs, path.method || "get", headers, path.queryseparator || "&", definition.search.allowEmptyInputs === true);
        const followRedirect = path.followredirect ?? definition.followredirect;
        const response = await session.request(details.url, { ...details, signal, maxBytes: 5 * 1024 * 1024, maxRedirects: followRedirect === false ? 0 : undefined });
        if (response.status < 200 || response.status >= 400) throw new Error(`Indexer search returned HTTP ${response.status}.`);
        let body = response.body;
        if (definition.search.preprocessingfilters?.length) body = Buffer.from(String(applyFilters(body.toString("utf8"), definition.search.preprocessingfilters)));
        const parsed = responseDocument(body, path.response?.type);
        const searchError = pageError(definition.search.error, parsed, template);
        if (searchError) throw new Error(searchError);
        const rows = rowsFrom(parsed, definition.search.rows);
        for (const row of rows) {
          if (candidates.length >= 200) break;
          const result = {};
          for (const [field, selector] of Object.entries(definition.search.fields)) {
            const rawField = field.split("|")[0];
            const fieldName = rawField.startsWith("_") ? rawField : rawField.replace(/_[A-Za-z0-9_]+$/, "");
            const value = selectorValue(selector, row, parsed.kind, templateContext(context, config, result));
            if (value !== "") result[fieldName] = result[fieldName] ? `${result[fieldName]}${value}` : value;
          }
          if (!result.title) continue;
          if (definition.search.rows.filters?.some((filter) => filter.name === "andmatch")) {
            const words = keywords.toLowerCase().split(/\s+/).filter(Boolean);
            if (!words.every((word) => String(result.title).toLowerCase().includes(word))) continue;
          }
          const magnet = String(result.magnet || result.download || "").startsWith("magnet:") ? String(result.magnet || result.download) : null;
          const download = magnet ? null : absolute(result.download || result.details, response.url);
          const resolver = download ? () => resolveDownload(definition, config, session, base, download, result, signal) : null;
          candidates.push({
            title: String(result.title),
            indexer: provider.name,
            size: sizeBytes(result.size),
            seeders: count(result.seeders),
            leechers: count(result.leechers),
            infoHash: String(result.infohash || "") || null,
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
