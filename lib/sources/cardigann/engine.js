import { load } from "cheerio";
import { JSONPath } from "jsonpath-plus";
import { renderTemplate } from "./template.js";
import { applyFilters } from "./filters.js";
import { cardigannSession } from "./transport.js";
import { configurationComplete, validateDefinitionObject } from "./definition.js";
import { withRegexExecution } from "./regex.js";
import { SourceError } from "../contract.js";

const mirrorsKey = Symbol.for("torplay.sources.cardigannMirrors");
const CONNECTIVITY = new Set(["REMOTE_DNS_FAILED", "REMOTE_CONNECTION_FAILED", "REMOTE_REQUEST_TIMEOUT"]);

function variables(context, config, result = {}, extra = {}) {
  const imdb = context.imdbId || "";
  const today = new Date();
  return { Config: config, Result: result, Keywords: context.title || "", Categories: extra.categories || [],
    Query: { Type: context.type === "show" ? "tvsearch" : context.type === "movie" ? "movie" : "search",
      Q: context.title || "", Keywords: context.title || "", Movie: context.title || "", Series: context.title || "",
      Season: context.season ?? "", Episode: context.episode ?? "", Ep: context.episode ?? "",
      IMDBID: imdb, IMDBIDShort: imdb.replace(/^tt/, ""), TMDBID: context.tmdbId ?? "", Year: context.year ?? "" },
    ImdbID: imdb, IMDBID: imdb, TMDbID: context.tmdbId ?? "", Season: context.season ?? "", Episode: context.episode ?? "", Year: context.year ?? "",
    Today: { Year: today.getUTCFullYear(), Month: today.getUTCMonth() + 1, Day: today.getUTCDate() }, DownloadUri: extra.downloadUri || {} };
}

async function object(values, context) {
  const entries = [];
  for (const [name, value] of Object.entries(values || {})) {
    const rendered = [];
    for (const entry of Array.isArray(value) ? value : [value]) rendered.push(await renderTemplate(entry, context));
    entries.push([name, Array.isArray(value) ? rendered : rendered[0]]);
  }
  return Object.fromEntries(entries);
}

function page(response, type, encoding) {
  const string = new TextDecoder(encoding || "UTF-8").decode(response.body);
  if (type === "json") {
    try { return { kind: "json", document: JSON.parse(string), text: string }; }
    catch { throw new SourceError("INVALID_RESPONSE", "The source returned invalid JSON."); }
  }
  if (/<title[^>]*>\s*(?:just a moment|attention required|checking your browser|verify you are human)/i.test(string)
    || /id=["'](?:challenge-form|cf-chl-)/i.test(string)) throw new SourceError("SOURCE_UNAVAILABLE", "The source requires browser verification.", 403);
  return { kind: "markup", document: load(string, { xmlMode: type === "xml" }), text: string };
}

function jsonSelect(document, selector) {
  const path = selector.startsWith("$") ? selector : `$.${selector.replace(/^\./, "")}`;
  return JSONPath({ json: document, path, wrap: true, eval: false });
}

async function select(block, document, kind, context) {
  if (!block) return "";
  let value;
  const render = (input) => renderTemplate(input, context);
  if (block.text !== undefined) value = await render(block.text);
  else if (kind === "json") {
    const matches = jsonSelect(document, await render(block.selector || "$"));
    value = matches.length > 1 ? matches : matches[0];
    if (block.case && value != null) {
      const replacement = block.case[String(value)] ?? block.case["*"];
      if (replacement !== undefined) value = await render(replacement);
    }
  } else {
    let element = block.selector ? document.find(await render(block.selector)).first() : document;
    if (block.remove) { element = element.clone(); element.find(await render(block.remove)).remove(); }
    if (block.case) {
      const found = Object.entries(block.case).find(([selector]) => selector === "*" || element.is(selector) || element.find(selector).length);
      if (found) value = await render(found[1]);
    }
    value ??= block.attribute ? element.attr(await render(block.attribute)) : element.text();
  }
  if (value == null || value === "") value = block.default === undefined ? "" : await render(block.default);
  return await applyFilters(value, block.filters, { render });
}

async function rows(parsed, block, context) {
  const selector = await renderTemplate(block.selector || (parsed.kind === "json" ? "$" : ""), context);
  if (parsed.kind === "json") {
    const selected = jsonSelect(parsed.document, selector).flat();
    const attribute = block.attribute ? await renderTemplate(block.attribute, context) : null;
    if (block.attribute && block.missingAttributeEqualsNoResults
      && selected.some((row) => row?.[attribute] == null)) return [];
    return selected.flatMap((row) => {
      const nested = block.attribute ? row?.[attribute] : row;
      if (nested == null) return [];
      return block.multiple && Array.isArray(nested) ? nested : [nested];
    }).slice(block.after || 0, (block.after || 0) + 200);
  }
  const remove = block.remove ? await renderTemplate(block.remove, context) : null;
  return (selector ? parsed.document(selector) : parsed.document.root().children()).toArray()
    .slice(block.after || 0, (block.after || 0) + 200).map((element) => {
      let row = parsed.document(element);
      if (remove) { row = row.clone(); row.find(remove).remove(); }
      return row;
    });
}

function details(base, path, inputs = {}, method = "get", headers = {}, separator = "&", allowEmpty = true) {
  const url = new URL(path || "", base);
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(inputs)) {
    if (name === "$raw") for (const [key, entry] of new URLSearchParams(String(value))) query.append(key, entry);
    else if (allowEmpty || (value !== "" && value != null)) query.append(name, String(value));
  }
  if (String(method).toLowerCase() === "post") return { url, method: "POST", body: query.toString(), headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers } };
  if (query.size) url.search = url.search ? `${url.search.slice(1)}${separator}${query}` : query.toString();
  return { url, method: "GET", headers };
}

async function detectErrors(errors, current, session, base, context, encoding, signal, authentication = false) {
  for (const error of errors || []) {
    signal?.throwIfAborted();
    const parsed = error.path ? page(await session.request(new URL(await renderTemplate(error.path, context), base), { signal }), "html", encoding) : current;
    const selector = await renderTemplate(error.selector, context);
    const found = parsed.kind === "json" ? jsonSelect(parsed.document, selector).length : parsed.document(selector).length;
    if (found) throw new SourceError(authentication ? "AUTHENTICATION_FAILED" : "SOURCE_UNAVAILABLE",
      authentication ? "Source authentication failed." : "The source rejected the search.", authentication ? 401 : 502);
  }
}

async function login(definition, session, base, context, signal) {
  const block = definition.login;
  if (!block) return;
  const render = (value) => renderTemplate(value, context);
  for (const cookie of block.cookies || []) await session.jar.setCookie(await render(cookie), base);
  const method = block.method || "form";
  let path = await render(block.path || "");
  let inputs = await object(block.inputs, context);
  let response;
  if (method === "cookie") {
    const cookie = inputs.cookie || context.Config.cookie || context.Config.cookies;
    if (!cookie) throw new SourceError("CONFIGURATION_REQUIRED", "Configure the source cookie.");
    for (const pair of String(cookie).split(";").filter(Boolean)) await session.jar.setCookie(pair.trim(), base);
  } else {
    if (method === "oneurl") { path += inputs.oneurl || ""; inputs = {}; }
    if (method === "form") {
      const document = page(await session.request(new URL(path, base), { signal }), "html", definition.encoding).document;
      const form = document(await render(block.form || "form")).first();
      if (!form.length) throw new SourceError("INVALID_RESPONSE", "The source login form was not found.");
      const fields = {};
      form.find("input[name]").each((_index, element) => { fields[document(element).attr("name")] = document(element).attr("value") || ""; });
      for (const [name, value] of Object.entries(inputs)) {
        const key = block.selectors ? form.find(name).first().attr("name") : name;
        if (!key) throw new SourceError("CONFIGURATION_REQUIRED", "A source login field was not found.");
        fields[key] = value;
      }
      for (const [name, selector] of Object.entries(block.selectorinputs || {})) fields[name] = await select(selector, form, "markup", context);
      for (const [name, selector] of Object.entries(block.getselectorinputs || {})) fields[name] = await select(selector, document.root(), "markup", context);
      inputs = fields;
      path = await render(block.submitpath || form.attr("action") || path);
    }
    const operation = details(base, path, inputs, ["get", "oneurl"].includes(method) ? "get" : "post", await object(block.headers, context));
    response = await session.request(operation.url, { ...operation, signal, credentials: true });
    await detectErrors(block.error, page(response, "html", definition.encoding), session, base, context, definition.encoding, signal, true);
  }
  if (block.test?.path) response = await session.request(new URL(await render(block.test.path), base), { signal });
  if (block.test?.selector && (!response || !page(response, "html", definition.encoding).document(await render(block.test.selector)).length)) {
    throw new SourceError("AUTHENTICATION_FAILED", "Source authentication failed.", 401);
  }
}

function categoryIds(definition, context) {
  const prefixes = context.categories?.length ? context.categories : context.type === "movie" ? ["Movies"] : context.type === "show" ? ["TV"] : [];
  const entries = [...Object.entries(definition.caps.categories || {}), ...(definition.caps.categorymappings || []).map((item) => [String(item.id), item.cat])];
  return [...new Set(entries.filter(([, name]) => !prefixes.length || prefixes.some((prefix) => name === prefix || name.startsWith(`${prefix}/`))).map(([id]) => id))];
}

function byteSize(value) {
  const match = String(value ?? "").replaceAll(",", "").match(/^\s*([\d.]+)\s*([kmgtp]?)(i?b)?/i);
  if (!match) return null;
  const power = " kmgtp".indexOf(match[2].toLowerCase());
  const size = Math.floor(Number(match[1]) * (match[3]?.toLowerCase() === "ib" ? 1024 : 1000) ** Math.max(0, power));
  return Number.isSafeInteger(size) ? size : null;
}

function downloadUri(url) {
  return { AbsoluteUri: url.href, AbsolutePath: url.pathname, Scheme: url.protocol.slice(0, -1),
    Host: url.host, PathAndQuery: `${url.pathname}${url.search}`, Query: Object.fromEntries(url.searchParams) };
}

async function resolveDownload(definition, session, base, config, result, rawUrl, signal) {
  signal?.throwIfAborted();
  let url = new URL(rawUrl, base);
  const context = variables({}, config, result, { downloadUri: downloadUri(url) });
  const block = definition.download;
  const headers = await object(block?.headers, context);
  const get = (target, extra = {}) => session.request(target, { headers, signal, method: String(block?.method || "get").toUpperCase(), metadata: true, ...extra });
  let before;
  let current;
  if (block?.before) {
    let path = block.before.path;
    if (block.before.pathselector) {
      current = await get(url, { metadata: false });
      path = await select(block.before.pathselector, page(current, "html", definition.encoding).document.root(), "markup", context);
    }
    if (!path) throw new SourceError("INVALID_RESPONSE", "Download preparation did not return a URL.");
    const operation = details(base, await renderTemplate(path, context), await object(block.before.inputs, context), block.before.method,
      headers, block.before.queryseparator);
    before = await get(operation.url, { ...operation, metadata: false });
  }
  current = await get(url);
  if (/bittorrent|octet-stream/i.test(current.headers["content-type"] || "") || current.body[0] === 100) return { torrentInput: current.body };
  const parsed = page(current, "html", definition.encoding);
  const rawMagnet = parsed.text.match(/magnet:\?[^\s"'<>]+/i)?.[0];
  for (const selector of block?.selectors || []) {
    const response = selector.usebeforeresponse && before ? before : current;
    const value = await select(selector, page(response, "html", definition.encoding).document.root(), "markup", context);
    if (!value) continue;
    if (String(value).startsWith("magnet:")) return { magnet: String(value).replaceAll("&amp;", "&") };
    url = new URL(value, response.url);
    const downloaded = await get(url);
    if (!/bittorrent|octet-stream/i.test(downloaded.headers["content-type"] || "") && downloaded.body[0] !== 100) {
      const magnet = downloaded.body.toString("utf8").match(/magnet:\?[^\s"'<>]+/i)?.[0];
      if (magnet) return { magnet: magnet.replaceAll("&amp;", "&") };
    }
    return { torrentInput: downloaded.body };
  }
  if (block?.infohash) {
    const response = block.infohash.usebeforeresponse && before ? before : current;
    const document = page(response, "html", definition.encoding).document.root();
    const hash = await select(block.infohash.hash, document, "markup", context);
    if (/^[a-f\d]{40}$/i.test(String(hash))) return { infoHash: hash };
  }
  if (rawMagnet) return { magnet: rawMagnet.replaceAll("&amp;", "&") };
  if (!block) return { torrentInput: current.body };
  throw new SourceError("INVALID_RESPONSE", "Download resolution returned no torrent metadata.");
}

async function searchMirror(source, context, base, options) {
  const definition = source.definition;
  const config = { ...source.settings, sitelink: base };
  const session = cardigannSession(definition, base, options.environment || process.env,
    { ...options, sourceKey: `${source.id}:${source.definitionHash}` });
  const categories = categoryIds(definition, context);
  if (context.type !== "generic" && !categories.length) return [];
  const variablesFor = (result = {}, selected = categories) => variables(context, config, result, { categories: selected });
  const template = variablesFor();
  await login(definition, session, base, template, options.signal);
  const keywords = await applyFilters(context.title, definition.search.keywordsfilters, { render: (value) => renderTemplate(value, template) });
  template.Keywords = keywords;
  template.Query.Q = keywords;
  template.Query.Keywords = keywords;
  const candidates = [];
  const paths = definition.search.paths || [{ path: definition.search.path }];
  if (paths.length > 10) throw new SourceError("CARDIGANN_UNSUPPORTED", "The definition has too many search paths.");
  for (const path of paths) {
    options.signal?.throwIfAborted();
    const exclusions = (path.categories || []).filter((value) => String(value).startsWith("!")).map((value) => String(value).slice(1));
    const inclusions = (path.categories || []).filter((value) => !String(value).startsWith("!")).map(String);
    if (categories.some((value) => exclusions.includes(value))) continue;
    const selected = inclusions.length ? categories.filter((value) => inclusions.includes(value)) : categories;
    if (categories.length && inclusions.length && !selected.length) continue;
    const currentContext = { ...template, Categories: selected };
    const operation = details(base, await renderTemplate(path.path, currentContext), await object({
      ...(path.inheritinputs === false ? {} : definition.search.inputs), ...path.inputs,
    }, currentContext), path.method, await object(definition.search.headers, currentContext), path.queryseparator, definition.search.allowEmptyInputs === true);
    const response = await session.request(operation.url, { ...operation, signal: options.signal,
      maxRedirects: (path.followredirect ?? definition.followredirect) === false ? 0 : undefined });
    let parsed = page(response, path.response?.type, definition.encoding);
    if (path.response?.noResultsMessage && parsed.text.includes(path.response.noResultsMessage)) continue;
    await detectErrors(definition.search.error, parsed, session, base, currentContext, definition.encoding, options.signal);
    if (definition.search.preprocessingfilters?.length) parsed = page({ ...response, body: Buffer.from(String(await applyFilters(parsed.text,
      definition.search.preprocessingfilters, { render: (value) => renderTemplate(value, currentContext) }))) }, path.response?.type, "UTF-8");
    if (definition.search.rows.count && Number(await select(definition.search.rows.count,
      parsed.kind === "json" ? parsed.document : parsed.document.root(), parsed.kind, currentContext)) === 0) continue;
    for (const row of await rows(parsed, definition.search.rows, currentContext)) {
      options.signal?.throwIfAborted();
      if (candidates.length >= 200) break;
      const result = {};
      for (const [name, selector] of Object.entries(definition.search.fields)) {
        const [field, mode] = name.split("|");
        const key = field.startsWith("_") ? field : field.replace(/_[A-Za-z0-9_]+$/, "");
        const value = await select(selector, row, parsed.kind, variablesFor(result, selected));
        if (value !== "") result[key] = result[key] && mode !== "noappend" ? `${result[key]}${value}` : value;
      }
      if (!result.date && parsed.kind !== "json" && definition.search.rows.dateheaders) {
        const block = definition.search.rows.dateheaders;
        const selector = await renderTemplate(block.selector || "", currentContext);
        const header = row.prevAll(selector).first();
        if (header.length) result.date = await select({ ...block, selector: undefined }, header, "markup", currentContext);
      }
      if (!result.title) continue;
      if ((definition.search.rows.filters || []).some((filter) => filter.name === "andmatch")
        && !String(keywords).toLowerCase().split(/\s+/).filter(Boolean).every((word) => String(result.title).toLowerCase().includes(word))) continue;
      const location = String(result.magnet || result.download || result.details || "");
      let locator;
      if (location.startsWith("magnet:")) locator = { magnet: location };
      else if (location) {
        const url = new URL(location, response.url);
        locator = { resolve: ({ signal } = {}) => withRegexExecution(() => resolveDownload(definition, session, base, config, result, url, signal), signal) };
      } else locator = {};
      const imdb = String(result.imdbid || result.imdb || "").replace(/^tt/, "");
      candidates.push({ title: String(result.title), infoHash: result.infohash,
        size: byteSize(result.size), seeders: result.seeders == null ? null : String(result.seeders).replaceAll(",", ""),
        leechers: result.leechers == null ? null : String(result.leechers).replaceAll(",", ""),
        media: { imdbId: /^\d+$/.test(imdb) ? `tt${imdb}` : null, tmdbId: result.tmdbid,
          year: result.year, season: result.season, episode: result.episode }, locator });
    }
  }
  return candidates;
}

async function executeCardigann(source, context, options) {
  validateDefinitionObject(source.definition);
  if (!configurationComplete(source.definition, source.settings)) throw new SourceError("CONFIGURATION_REQUIRED", "Complete the source configuration.");
  if (Object.keys(source.settings || {}).some((key) => /cookie|pass|secret|token|api.?key/i.test(key) && source.settings[key])
    && source.definition.links.some((link) => new URL(link).protocol !== "https:")) throw new SourceError("CONFIGURATION_REQUIRED", "Source credentials require HTTPS links.");
  const mirrors = globalThis[mirrorsKey] ??= new Map();
  while (mirrors.size > 200) mirrors.delete(mirrors.keys().next().value);
  const key = `${source.id}:${source.definitionHash}`;
  const links = source.definition.links;
  const active = mirrors.get(key);
  const ordered = active && links.includes(active) ? [active, ...links.filter((link) => link !== active)] : links;
  let failure;
  for (const base of ordered) {
    options.signal?.throwIfAborted();
    try {
      const results = await searchMirror(source, context, base, options);
      mirrors.set(key, base);
      return results;
    } catch (error) {
      options.signal?.throwIfAborted();
      if (!CONNECTIVITY.has(error?.code)) {
        if (error instanceof SourceError || error?.code?.startsWith("REMOTE_")) throw error;
        throw new SourceError("INVALID_RESPONSE", "The source definition could not process the response.");
      }
      failure = error;
    }
  }
  throw failure;
}

export async function searchCardigann(source, context, options = {}) {
  return withRegexExecution(() => executeCardigann(source, context, options), options.signal);
}

export async function verifyCardigann(source, options = {}) {
  const type = source.capabilities.mediaTypes.includes("Movies") ? "movie" : "show";
  await searchCardigann(source, { title: "Sintel", type, season: 1, episode: 1 }, options);
  // A successfully parsed empty search is not a transport or authentication failure.
  return source.capabilities;
}
