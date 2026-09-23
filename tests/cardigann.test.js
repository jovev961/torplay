import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stringify } from "yaml";
import { cardigannAdapter, testCardigannProvider } from "../lib/search/cardigann/engine.js";
import {
  importDefinition,
  normalizeDefinitionUrl,
  parseDefinition,
  settingDescriptors,
  validateDefinitionSettings,
} from "../lib/search/cardigann/definition.js";
import { applyFilters } from "../lib/search/cardigann/filters.js";
import { pinnedLookup, resolvePublicAddress, safeRequest } from "../lib/search/cardigann/http.js";
import { renderTemplate } from "../lib/search/cardigann/template.js";
import {
  createCardigannProvider,
  publicCustomProviders,
  readCustomProviders,
  testCardigannProviderConnection,
  updateCardigannProvider,
} from "../lib/settings/torrent-providers.js";

const definition = {
  id: "example",
  name: "Example Indexer",
  description: "Synthetic test definition",
  language: "en-US",
  type: "public",
  encoding: "UTF-8",
  links: ["https://indexer.example/"],
  caps: {
    categories: { "2000": "Movies", "5000": "TV" },
    modes: { search: ["q"], "movie-search": ["q", "imdbid"], "tv-search": ["q", "season", "ep"] },
  },
  settings: [
    { name: "token", label: "Token", type: "password" },
    { name: "safe", label: "Safe search", type: "checkbox", default: true },
  ],
  search: {
    path: "/search",
    inputs: { q: "{{ .Keywords }}" },
    rows: { selector: ".result" },
    fields: {
      title: { selector: ".title" },
      size: { selector: ".size" },
      seeders: { selector: ".seeders" },
      category: { text: "Movies" },
      magnet: { selector: "a", attribute: "href" },
    },
  },
};

function response(url, body, status = 200, headers = {}) {
  return { status, headers, body: Buffer.from(body), url: new URL(url) };
}

test("definition URLs accept public YAML and normalize GitHub blob pages", () => {
  assert.equal(
    normalizeDefinitionUrl("https://github.com/Prowlarr/Indexers/blob/master/definitions/v11/example.yml#readme"),
    "https://raw.githubusercontent.com/Prowlarr/Indexers/master/definitions/v11/example.yml",
  );
  assert.equal(
    normalizeDefinitionUrl("https://raw.githubusercontent.com/Prowlarr/Indexers/master/definitions/v11/example.yml"),
    "https://raw.githubusercontent.com/Prowlarr/Indexers/master/definitions/v11/example.yml",
  );
  assert.equal(normalizeDefinitionUrl("https://definitions.example/index.yaml"), "https://definitions.example/index.yaml");
  assert.throws(() => normalizeDefinitionUrl("http://definitions.example/index.yml"), /public HTTPS/);
  assert.throws(() => normalizeDefinitionUrl("https://user:secret@definitions.example/index.yml"), /without embedded credentials/);
  assert.throws(() => normalizeDefinitionUrl("not a URL"), (error) => error.code === "CARDIGANN_URL_INVALID");
  assert.throws(() => normalizeDefinitionUrl("https://github.com/Prowlarr/Indexers/tree/master/definitions"), /individual/);
  assert.throws(() => normalizeDefinitionUrl("https://definitions.example/index.json"), /\.yml or \.yaml/);
});

test("Cardigann v11 definitions are schema checked and report unsupported features", () => {
  const parsed = parseDefinition(stringify(definition));
  assert.deepEqual(parsed.capabilities.mediaTypes, ["Movies", "TV"]);
  assert.deepEqual(parsed.capabilities.categories, ["Movies", "TV"]);
  assert.throws(() => parseDefinition("id: broken"), /valid Cardigann v11/);
  try {
    parseDefinition(stringify({ ...definition, login: { method: "post", path: "/login", captcha: { type: "image", selector: "img", input: "captcha" } } }));
    assert.fail("CAPTCHA definition should have failed");
  } catch (error) {
    assert.equal(error.code, "CARDIGANN_UNSUPPORTED");
    assert.deepEqual(error.unsupportedFeatures[0], {
      feature: "captcha",
      path: "definition.login.captcha",
      message: "CAPTCHA-based login is not supported.",
    });
  }
  assert.doesNotThrow(() => parseDefinition(stringify({ ...definition, download: { before: { path: "/token" } } })));
  assert.doesNotThrow(() => parseDefinition(stringify({
    ...definition,
    settings: [{ name: "info_flaresolverr", type: "info_flaresolverr" }],
  })));
});

test("definition settings validate options and preserve stored secrets", () => {
  assert.deepEqual(validateDefinitionSettings(definition, { token: "new", safe: false }), { token: "new", safe: false });
  assert.deepEqual(validateDefinitionSettings(definition, { token: "", safe: true }, { token: "stored" }), { token: "stored", safe: true });
  assert.throws(() => validateDefinitionSettings(definition, { token: "x", extra: "no" }), /unknown field/);
});

test("definition settings preserve generic controls and informational guidance", () => {
  const configured = {
    ...definition,
    settings: [
      { name: "username", label: "Username", type: "text" },
      { name: "password", label: "Password", type: "password" },
      { name: "section", label: "Section", type: "select", options: { all: "All", trusted: "Trusted" }, default: "all" },
      { name: "safe", label: "Safe search", type: "checkbox", default: true },
      { name: "cookie-help", label: "Paste the cookie from an authenticated browser session.", type: "info_cookie" },
    ],
  };
  const descriptors = settingDescriptors(configured);
  assert.deepEqual(descriptors.map((field) => field.type), ["text", "password", "select", "checkbox", "info_cookie"]);
  assert.equal(descriptors[0].required, false);
  assert.equal(descriptors[1].required, false);
  assert.equal(descriptors.at(-1).informational, true);
  assert.deepEqual(validateDefinitionSettings(configured, {}), {
    username: "", password: "", section: "all", safe: true,
  });
  assert.deepEqual(validateDefinitionSettings(configured, { username: "  ", password: "" }, { password: "stored" }), {
    username: "", password: "stored", section: "all", safe: true,
  });
  assert.deepEqual(validateDefinitionSettings(configured, {
    username: "alice", password: "secret", section: "trusted", safe: false,
  }), { username: "alice", password: "secret", section: "trusted", safe: false });
  const requiredChoice = { ...configured, settings: [{ name: "region", label: "Region", type: "select", options: { us: "US" } }] };
  assert.equal(settingDescriptors(requiredChoice)[0].required, true);
  assert.throws(() => validateDefinitionSettings(requiredChoice, {}), /Region is required/);
});

test("Cardigann templates and filters render supported expressions without evaluation", () => {
  assert.equal(renderTemplate("{{ if eq .Query.Type \"movie\" }}movie{{ else }}other{{ end }}", { Query: { Type: "movie" } }), "movie");
  assert.equal(renderTemplate("{{ range $item := .Items }}{{$item}},{{ end }}", { Items: ["a", "b"] }), "a,b,");
  assert.equal(renderTemplate("{{ range .Items }}{{.}},{{ end }}", { Items: ["a", "b"] }), "a,b,");
  assert.equal(renderTemplate("{{ if .Config.missing }}wrong{{ else }}empty{{ end }}", { Config: {} }), "empty");
  assert.equal(applyFilters("SINTÉL", [{ name: "tolower" }, { name: "diacritics" }, { name: "append", args: " 2010" }]), "sintel 2010");
  assert.throws(() => renderTemplate("{{ dangerous .Query }}", {}), /Unsupported Cardigann template function/);
});

test("pinned DNS lookup supports Node single-address and all-address callback contracts", async () => {
  const lookup = pinnedLookup({ address: "93.184.216.34", family: 4 });
  const single = await new Promise((resolve, reject) => lookup("public.example", {}, (error, address, family) => error ? reject(error) : resolve({ address, family })));
  const all = await new Promise((resolve, reject) => lookup("public.example", { all: true }, (error, addresses) => error ? reject(error) : resolve(addresses)));
  assert.deepEqual(single, { address: "93.184.216.34", family: 4 });
  assert.deepEqual(all, [{ address: "93.184.216.34", family: 4 }]);
});

test("network guard rejects unsafe DNS and reports DNS failures safely", async () => {
  await assert.rejects(
    resolvePublicAddress("private.example", (_host, _options, callback) => callback(null, [{ address: "127.0.0.1", family: 4 }])),
    (error) => error.code === "REMOTE_DESTINATION_BLOCKED" && /blocked/.test(error.message),
  );
  await assert.rejects(
    resolvePublicAddress("mixed.example", (_host, _options, callback) => callback(null, [
      { address: "93.184.216.34", family: 4 }, { address: "169.254.1.1", family: 4 },
    ])),
    (error) => error.code === "REMOTE_DESTINATION_BLOCKED",
  );
  await assert.rejects(
    resolvePublicAddress("missing.example", (_host, _options, callback) => callback(Object.assign(new Error("internal resolver detail"), { code: "ENOTFOUND" }))),
    (error) => error.code === "REMOTE_DNS_FAILED" && error.message === "The destination hostname could not be resolved.",
  );
  const resolved = await resolvePublicAddress("public.example", (_host, _options, callback) => callback(null, [{ address: "93.184.216.34", family: 4 }]));
  assert.equal(resolved.address, "93.184.216.34");
});

test("safe requests follow HTTPS redirects and block unsafe redirects", async () => {
  const followed = [];
  const redirected = await safeRequest("https://public.example/start", {
    requestImpl: async (url) => {
      followed.push(url.toString());
      return followed.length === 1
        ? response(url, "", 302, { location: "https://cdn.example/definition.yml" })
        : response(url, "definition", 200);
    },
  });
  assert.equal(redirected.status, 200);
  assert.deepEqual(followed, ["https://public.example/start", "https://cdn.example/definition.yml"]);
  const seen = [];
  await assert.rejects(safeRequest("https://public.example/start", {
    requestImpl: async (url) => {
      seen.push(url.toString());
      if (seen.length === 1) return response(url, "", 302, { location: "http://127.0.0.1/private" });
      throw new Error("must not request redirected private target");
    },
  }), (error) => error.code === "REMOTE_REDIRECT_BLOCKED");
  assert.deepEqual(seen, ["https://public.example/start"]);
  await assert.rejects(safeRequest("https://public.example/start", {
    protocols: ["http:", "https:"],
    requestImpl: async (url) => response(url, "", 302, { location: "http://public.example/insecure" }),
  }), (error) => error.code === "REMOTE_REDIRECT_BLOCKED");
  await assert.rejects(safeRequest("https://public.example/start", {
    requestImpl: async (url) => response(url, "", 302, { location: "https://[invalid" }),
  }), (error) => error.code === "REMOTE_REDIRECT_INVALID");
});

test("safe requests classify connection and timeout failures without leaking details", async () => {
  await assert.rejects(safeRequest("not a URL"), (error) => error.code === "REMOTE_URL_INVALID");
  await assert.rejects(safeRequest("https://user:secret@public.example/index.yml"), (error) => error.code === "REMOTE_URL_UNSUPPORTED");
  await assert.rejects(safeRequest("https://public.example/index.yml", {
    requestImpl: async () => { throw Object.assign(new Error("connect ECONNREFUSED 10.0.0.2:443"), { code: "ECONNREFUSED" }); },
  }), (error) => error.code === "REMOTE_CONNECTION_FAILED" && !error.message.includes("10.0.0.2"));
  await assert.rejects(safeRequest("https://public.example/index.yml", {
    requestImpl: async () => { throw Object.assign(new Error("socket detail"), { code: "ETIMEDOUT" }); },
  }), (error) => error.code === "REMOTE_REQUEST_TIMEOUT" && error.status === 504);
  await assert.rejects(safeRequest("https://public.example/index.yml", {
    requestImpl: async () => { throw Object.assign(new Error("sensitive upstream detail"), { status: 500 }); },
  }), (error) => error.code === "REMOTE_CONNECTION_FAILED" && !error.message.includes("sensitive"));
});

test("GitHub blob and raw URLs both enter the complete definition pipeline", async () => {
  const blobUrl = "https://github.com/Prowlarr/Indexers/blob/master/definitions/v11/example.yml";
  const rawUrl = "https://raw.githubusercontent.com/Prowlarr/Indexers/master/definitions/v11/example.yml";
  const requested = [];
  for (const url of [blobUrl, rawUrl]) {
    const imported = await importDefinition(url, {
      request: async (resolvedUrl) => {
        requested.push(String(resolvedUrl));
        return response(resolvedUrl, stringify({ ...definition, id: "download-regression" }));
      },
    });
    assert.equal(imported.definition.id, "download-regression");
    assert.equal(imported.compatibility.schemaVersion, 11);
  }
  assert.deepEqual(requested, [rawUrl, rawUrl]);
});

test("definition imports report HTTP and YAML failures at their actual stage", async () => {
  for (const status of [403, 404]) {
    await assert.rejects(importDefinition(`https://definitions.example/status-${status}.yml`, {
      request: async (url) => response(url, "", status),
    }), (error) => error.code === "CARDIGANN_DOWNLOAD_HTTP" && error.message === `The definition server returned HTTP ${status}.`);
  }
  await assert.rejects(importDefinition("https://definitions.example/invalid.yml", {
    request: async (url) => response(url, "not: [valid"),
  }), (error) => error.code === "CARDIGANN_INVALID" && /invalid YAML/.test(error.message));
});

test("live Cardigann verification reports safe and specific failure categories", async () => {
  const provider = { id: "cardigann-diagnostics", name: definition.name, definition, settings: { token: "secret", safe: true }, capabilities: parseDefinition(stringify(definition)).capabilities };
  for (const [status, code] of [[403, "CARDIGANN_HTTP_403"], [429, "CARDIGANN_RATE_LIMITED"]]) {
    await assert.rejects(testCardigannProvider(provider, {
      request: async (url) => response(url, "temporarily unavailable", status),
    }), (error) => error.code === code && !error.message.includes("secret"));
  }
  await assert.rejects(testCardigannProvider(provider, {
    request: async (url) => response(url, '<html><script src="/challenge-platform/test.js"></script>Verify you are human</html>', 403, { server: "cloudflare" }),
  }), (error) => error.code === "CARDIGANN_CHALLENGE_DETECTED");
  await assert.rejects(testCardigannProvider(provider, {
    request: async () => { throw Object.assign(new Error("lookup contained private internal detail"), { code: "ENOTFOUND" }); },
  }), (error) => error.code === "REMOTE_DNS_FAILED" && !error.message.includes("internal"));
  await assert.rejects(testCardigannProvider(provider, {
    request: async (url) => response(url, "<html></html>"),
  }), (error) => error.code === "CARDIGANN_NO_SEARCH_ROWS");

  const jsonDefinition = {
    ...definition,
    search: { ...definition.search, paths: [{ path: "/search", response: { type: "json" } }] },
  };
  await assert.rejects(testCardigannProvider({ ...provider, definition: jsonDefinition }, {
    request: async (url) => response(url, "not-json"),
  }), (error) => error.code === "CARDIGANN_RESPONSE_PARSE_FAILED");
});

test("Cardigann adapter searches HTML and keeps magnets server-side", async () => {
  const requests = [];
  const provider = { id: "cardigann-example", name: definition.name, definition, settings: { token: "secret", safe: true }, capabilities: { mediaTypes: ["Movies", "TV"], modes: definition.caps.modes } };
  const adapter = cardigannAdapter(provider, { request: async (url, options) => {
    requests.push({ url: String(url), options });
    return response(url, '<article class="result"><span class="title">Sintel 2010</span><span class="size">1.5 GB</span><span class="seeders">42</span><a href="magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&amp;dn=Sintel">Get</a></article>');
  } });
  const results = await adapter.search({ title: "Sintel", type: "movie", imdbId: "tt1727587" });
  assert.equal(requests[0].url, "https://indexer.example/search?q=Sintel");
  assert.equal(results.length, 1);
  assert.equal(results[0].size, Math.floor(1.5 * 1024 ** 3));
  assert.equal(results[0].seeders, 42);
  assert.match(results[0].source.magnet, /^magnet:/);
});

test("only marked Cardigann definitions use configured FlareSolverr", async () => {
  const marked = { ...definition, settings: [{ name: "flare", type: "info_flaresolverr" }] };
  const provider = { id: "cardigann-flare", name: marked.name, definition: marked, settings: {},
    capabilities: { mediaTypes: ["Movies", "TV"], modes: marked.caps.modes } };
  await assert.rejects(cardigannAdapter(provider, { environment: {} }).search({ title: "Sintel", type: "movie" }),
    { code: "FLARESOLVERR_NOT_CONFIGURED" });
  let calls = 0;
  const solvedPage = '<html><head><title>Download Sintel Torrents</title><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script></head><body><article class="result"><span class="title">Sintel</span><a href="magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa">Get</a></article></body></html>';
  const adapter = cardigannAdapter(provider, {
    environment: { FLARESOLVERR_URL: "http://localhost:8191" },
    validateTarget: async (hostname) => assert.equal(hostname, "indexer.example"),
    requestImpl: async () => assert.fail("A marked source must not make a direct HTTP request."),
    fetchImpl: async (url, options) => {
      calls += 1;
      assert.equal(String(url), "http://localhost:8191/v1");
      assert.deepEqual(JSON.parse(options.body), {
        cmd: "request.get", url: "https://indexer.example/search?q=Sintel", maxTimeout: 60000,
      });
      return new Response(JSON.stringify({ status: "ok", solution: {
        url: "https://indexer.example/search?q=Sintel", status: 200,
        headers: { server: "cloudflare" }, response: solvedPage,
      } }));
    },
  });
  assert.equal((await adapter.search({ title: "Sintel", type: "movie" })).length, 1);
  assert.deepEqual(await testCardigannProvider(provider, {
    environment: { FLARESOLVERR_URL: "http://localhost:8191" },
    validateTarget: async (hostname) => assert.equal(hostname, "indexer.example"),
    requestImpl: async () => assert.fail("Verification must not make a direct HTTP request."),
    fetchImpl: async (url, options) => {
      calls += 1;
      assert.equal(String(url), "http://localhost:8191/v1");
      assert.equal(JSON.parse(options.body).cmd, "request.get");
      return new Response(JSON.stringify({ status: "ok", solution: {
        url: "https://indexer.example/search?q=Sintel", status: 200,
        headers: { server: "cloudflare" }, response: solvedPage,
      } }));
    },
  }), provider.capabilities);
  assert.equal(calls, 2);
  await assert.rejects(cardigannAdapter(provider, {
    environment: { FLARESOLVERR_URL: "http://localhost:8191" },
    validateTarget: async () => {},
    fetchImpl: async () => new Response(JSON.stringify({ status: "ok", solution: {
      url: "https://indexer.example/search?q=Sintel", status: 200,
      response: '<html><title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/test.js"></script></html>',
    } })),
  }).search({ title: "Sintel", type: "movie" }), { code: "CARDIGANN_CHALLENGE_DETECTED" });

  const direct = cardigannAdapter({ ...provider, definition }, {
    environment: { FLARESOLVERR_URL: "http://localhost:8191" },
    fetchImpl: async () => assert.fail("An unmarked source must not use FlareSolverr."),
    requestImpl: async (url) => response(url, solvedPage),
  });
  assert.equal((await direct.search({ title: "Sintel", type: "movie" })).length, 1);
});

test("a FlareSolverr-backed source passes the Settings connection test after a solved challenge", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "torplay-cardigann-flare-test-"));
  const environment = { TORPLAY_CONFIG_PATH: path.join(directory, "torplay.env"), FLARESOLVERR_URL: "http://localhost:8191" };
  let serviceCalls = 0;
  try {
    const imported = await importDefinition("https://definitions.example/flared.yml", {
      request: async (url) => response(url, stringify({ ...definition, id: "flared-fixture",
        settings: [{ name: "info_flaresolverr", type: "info_flaresolverr" }] })),
    });
    const options = {
      environment,
      validateTarget: async (hostname) => assert.equal(hostname, "indexer.example"),
      requestImpl: async () => assert.fail("The indexer must not be contacted directly."),
      fetchImpl: async (url, requestOptions) => {
        serviceCalls += 1;
        assert.equal(String(url), "http://localhost:8191/v1");
        assert.equal(JSON.parse(requestOptions.body).url, "https://indexer.example/search?q=Sintel");
        return new Response(JSON.stringify({ status: "ok", solution: {
          url: "https://indexer.example/search?q=Sintel", status: 200, headers: { server: "cloudflare" },
          response: '<html><title>Search results</title><script src="/cdn-cgi/challenge-platform/main.js"></script><article class="result"><span class="title">Sintel</span><a href="magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa">Get</a></article></html>',
        } }));
      },
    };
    const [saved] = await createCardigannProvider({ importId: imported.importId, settings: {} }, options);
    assert.equal(saved.verification.status, "verified");
    assert.equal(publicCustomProviders(environment)[0].requiresFlareSolverr, true);
    const retested = await testCardigannProviderConnection({ id: saved.id }, options);
    assert.equal(retested.verification.status, "verified");
    assert.equal(readCustomProviders(environment)[0].verification.status, "verified");
    assert.equal(serviceCalls, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Cardigann adapter supports JSON and XML result documents", async () => {
  const provider = (responseType, rows, fields) => ({
    id: `cardigann-${responseType}`,
    name: responseType,
    definition: { ...definition, search: { ...definition.search, paths: [{ path: "/search", response: { type: responseType } }], path: undefined, rows, fields } },
    settings: {},
    capabilities: { mediaTypes: ["Movies"], modes: definition.caps.modes },
  });
  const json = cardigannAdapter(provider("json", { selector: "$.items[*]" }, {
    title: { selector: "$.title" }, size: { selector: "$.size" }, seeders: { selector: "$.seeders" },
    category: { text: "Movies" }, magnet: { selector: "$.magnet" },
  }), { request: async (url) => response(url, JSON.stringify({ items: [{ title: "Sintel JSON", size: "2 MB", seeders: 2, magnet: "magnet:?xt=urn:btih:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }] })) });
  const xml = cardigannAdapter(provider("xml", { selector: "item" }, {
    title: { selector: "title" }, size: { selector: "size" }, seeders: { selector: "seeders" },
    category: { text: "Movies" }, magnet: { selector: "magnet" },
  }), { request: async (url) => response(url, "<results><item><title>Sintel XML</title><size>3 MB</size><seeders>3</seeders><magnet>magnet:?xt=urn:btih:cccccccccccccccccccccccccccccccccccccccc</magnet></item></results>") });
  assert.equal((await json.search({ title: "Sintel", type: "movie" }))[0].title, "Sintel JSON");
  assert.equal((await xml.search({ title: "Sintel", type: "movie" }))[0].title, "Sintel XML");
});

test("Cardigann adapter renders raw category queries and expands JSON row attributes", async () => {
  const requests = [];
  const jsonDefinition = {
    ...definition,
    search: {
      paths: [{ path: "/api", response: { type: "json" }, categories: [2000] }],
      inputs: { $raw: "{{ range .Categories }}category[]={{.}}&{{ end }}", q: "{{ .Query.Keywords }}", t: "{{ .Query.Type }}", imdb: "{{ .Query.IMDBID }}", short: "{{ .Query.IMDBIDShort }}" },
      rows: { selector: "$.payload", attribute: "items", multiple: true },
      fields: {
        title: { selector: "$.title" }, size: { selector: "$.size" }, seeders: { selector: "$.seeders" },
        category: { text: "Movies" }, magnet: { selector: "$.magnet" },
      },
    },
  };
  const adapter = cardigannAdapter({
    id: "cardigann-json-rows", name: "JSON rows", definition: jsonDefinition, settings: {},
    capabilities: { mediaTypes: ["Movies"], modes: definition.caps.modes },
  }, { request: async (url) => {
    requests.push(String(url));
    return response(url, JSON.stringify({ payload: { items: [{
      title: "Sintel API", size: "4 MB", seeders: 4,
      magnet: "magnet:?xt=urn:btih:dddddddddddddddddddddddddddddddddddddddd",
    }] } }));
  } });
  const results = await adapter.search({ title: "Sintel", type: "movie", imdbId: "tt1727587" });
  const requested = new URL(requests[0]);
  assert.deepEqual(requested.searchParams.getAll("category[]"), ["2000"]);
  assert.equal(requested.searchParams.get("q"), "Sintel");
  assert.equal(requested.searchParams.get("t"), "movie");
  assert.equal(requested.searchParams.get("imdb"), "tt1727587");
  assert.equal(requested.searchParams.get("short"), "1727587");
  assert.equal(results[0].title, "Sintel API");
});

test("Cardigann category hierarchy survives import and supports exact anime searches", async () => {
  const categoryDefinition = {
    ...definition,
    caps: {
      ...definition.caps,
      categories: undefined,
      categorymappings: [
        { id: "2000", cat: "Movies" }, { id: "2040", cat: "Movies/HD" }, { id: "2045", cat: "Movies/UHD" },
        { id: "5000", cat: "TV" }, { id: "5040", cat: "TV/HD" }, { id: "5070", cat: "TV/Anime" },
        { id: "anime-native", cat: "TV/Anime" }, { id: "3000", cat: "Audio" }, { id: "7000", cat: "Books" },
        { id: "4000", cat: "PC" }, { id: "1000", cat: "Console" }, { id: "8000", cat: "Other" },
      ],
    },
    settings: [],
    search: {
      ...definition.search,
      inputs: { $raw: "{{ range .Categories }}category[]={{.}}&{{ end }}", q: "{{ .Keywords }}" },
    },
  };
  const parsed = parseDefinition(stringify(categoryDefinition));
  assert.deepEqual(parsed.capabilities.categories, [
    "Movies", "Movies/HD", "Movies/UHD", "TV", "TV/HD", "TV/Anime", "Audio", "Books", "PC", "Console", "Other",
  ]);
  const requested = [];
  const provider = { id: "cardigann-categories", name: "Category fixture", definition: categoryDefinition, settings: {}, capabilities: parsed.capabilities };
  const results = await cardigannAdapter(provider, { request: async (url) => {
    requested.push(new URL(url).searchParams.getAll("category[]"));
    return response(url, '<article class="result"><span class="title">Anime result</span><span class="size">1 MB</span><span class="seeders">1</span><a href="magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa">Get</a></article>');
  } }).search({ title: "Example", type: "show", categories: ["TV/Anime"] });
  assert.equal(results.length, 1);
  assert.deepEqual(requested[0], ["5070", "anime-native"]);
});

test("Cardigann adapter decodes definition-selected legacy encodings", async () => {
  const encoded = Buffer.concat([
    Buffer.from('<article class="result"><span class="title">'),
    Buffer.from([0xd2, 0xe5, 0xf1, 0xf2]),
    Buffer.from('</span><span class="size">1 MB</span><span class="seeders">2</span><a href="magnet:?xt=urn:btih:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee">Get</a></article>'),
  ]);
  const encodedDefinition = { ...definition, encoding: "windows-1251" };
  const adapter = cardigannAdapter({
    id: "cardigann-encoding", name: "Encoded", definition: encodedDefinition, settings: {},
    capabilities: { mediaTypes: ["Movies"], modes: definition.caps.modes },
  }, { request: async (url) => response(url, encoded) });
  assert.equal((await adapter.search({ title: "Test", type: "movie" }))[0].title, "Тест");
});

test("Cardigann form login uses definition selectors, hidden inputs, and session cookies", async () => {
  const requests = [];
  const privateDefinition = {
    ...definition,
    type: "private",
    login: {
      path: "/login", method: "form", form: "form#login", selectors: true,
      cookies: ["JAVA=OK"],
      inputs: { "#user": "{{ .Config.username }}", "#pass": "{{ .Config.password }}" },
      selectorinputs: { csrf: { selector: "input[name=csrf]", attribute: "value" } },
      test: { path: "/account", selector: ".logout" },
    },
    settings: [
      { name: "username", type: "text", label: "Username" },
      { name: "password", type: "password", label: "Password" },
    ],
  };
  const adapter = cardigannAdapter({
    id: "cardigann-login", name: "Private", definition: privateDefinition,
    settings: { username: "alice", password: "secret" }, capabilities: { mediaTypes: ["Movies"], modes: definition.caps.modes },
  }, { request: async (url, options) => {
    requests.push({ url: String(url), options });
    if (String(url).endsWith("/login") && options.method !== "POST") {
      return response(url, '<form id="login" action="/session"><input id="user" name="login"><input id="pass" name="password"><input name="csrf" value="token"></form>', 200, { "set-cookie": "sid=abc; Path=/" });
    }
    if (String(url).endsWith("/session")) return response(url, "ok", 200, { "set-cookie": "auth=yes; Path=/" });
    if (String(url).endsWith("/account")) return response(url, '<a class="logout">Logout</a>');
    return response(url, '<article class="result"><span class="title">Sintel</span><span class="size">1 MB</span><span class="seeders">1</span><a href="magnet:?xt=urn:btih:ffffffffffffffffffffffffffffffffffffffff">Get</a></article>');
  } });
  await adapter.search({ title: "Sintel", type: "movie" });
  const login = requests.find((item) => item.url.endsWith("/session"));
  assert.deepEqual(Object.fromEntries(new URLSearchParams(login.options.body)), { login: "alice", password: "secret", csrf: "token" });
  assert.match(login.options.headers.Cookie, /sid=abc/);
  assert.match(login.options.headers.Cookie, /JAVA=OK/);
  assert.match(requests.at(-1).options.headers.Cookie, /auth=yes/);
});

test("Cardigann download preparation can construct a magnet from a before response", async () => {
  const requests = [];
  const downloadDefinition = {
    ...definition,
    download: {
      before: { path: "/api/info", inputs: { id: "{{ re_replace .DownloadUri.AbsolutePath \"/info/\" \"\" }}" } },
      infohash: {
        usebeforeresponse: true,
        hash: { selector: ":root", filters: [{ name: "regexp", args: "([a-f0-9]{40})" }] },
        title: { selector: ":root", filters: [{ name: "regexp", args: "title:([^;]+)" }] },
      },
    },
    search: {
      ...definition.search,
      fields: { ...definition.search.fields, magnet: undefined, download: { selector: "a", attribute: "href" } },
    },
  };
  delete downloadDefinition.search.fields.magnet;
  const adapter = cardigannAdapter({
    id: "cardigann-download", name: "Download", definition: downloadDefinition, settings: {},
    capabilities: { mediaTypes: ["Movies"], modes: definition.caps.modes },
  }, { request: async (url) => {
    requests.push(String(url));
    if (String(url).includes("/api/info")) return response(url, "hash:1111111111111111111111111111111111111111;title:Sintel");
    if (String(url).includes("/info/")) return response(url, "<html>details</html>");
    return response(url, '<article class="result"><span class="title">Sintel</span><span class="size">1 MB</span><span class="seeders">1</span><a href="/info/42">Get</a></article>');
  } });
  const result = (await adapter.search({ title: "Sintel", type: "movie" }))[0];
  const resolved = await result.source.resolver();
  assert.match(requests.find((url) => url.includes("/api/info")), /id=42/);
  assert.equal(resolved.magnet, "magnet:?xt=urn:btih:1111111111111111111111111111111111111111&dn=Sintel");
});

test("imported definitions persist only after live verification and redact settings", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "torplay-cardigann-"));
  const environment = { TORPLAY_CONFIG_PATH: path.join(directory, "torplay.env") };
  try {
    const definitionYaml = `# retained import comment\n${stringify(definition)}`;
    const imported = await importDefinition("https://github.com/example/indexers/blob/main/example.yml", {
      request: async (url) => response(url, definitionYaml),
    });
    assert.deepEqual(imported.definition, {
      id: "example",
      name: "Example Indexer",
      access: "public",
      language: "en-US",
      mediaTypes: ["Movies", "TV"],
      categories: ["Movies", "TV"],
      website: "https://indexer.example/",
      sourceUrl: "https://github.com/example/indexers/blob/main/example.yml",
      settings: [
        { name: "token", label: "Token", type: "password", options: null, default: null, required: false, secret: true, configured: false },
        { name: "safe", label: "Safe search", type: "checkbox", options: null, default: true, required: false, secret: false, configured: false },
      ],
    });
    assert.deepEqual(readCustomProviders(environment), []);
    const providers = await createCardigannProvider({ importId: imported.importId, settings: { token: "private", safe: true } }, {
      environment,
      request: async (url) => response(url, '<div class="result"><span class="title">Sintel</span><span class="size">1 MB</span><span class="seeders">1</span><a href="magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa">Get</a></div>'),
    });
    assert.equal(providers[0].kind, "cardigann");
    assert.equal(JSON.stringify(providers).includes("private"), false);
    assert.equal(readCustomProviders(environment)[0].settings.token, "private");
    const stored = JSON.parse(await readFile(path.join(directory, "torrent-providers.json"), "utf8"));
    assert.equal(stored.providers[0].definitionYaml, definitionYaml);
    assert.equal(stored.providers[0].definitionSourceFormat, "original");
    assert.equal(publicCustomProviders(environment)[0].definitionUrl, "https://github.com/example/indexers/blob/main/example.yml");
    assert.equal(publicCustomProviders(environment)[0].access, "public");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("temporarily unreachable definitions can be confirmed as unverified and retested later", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "torplay-cardigann-unverified-"));
  const environment = { TORPLAY_CONFIG_PATH: path.join(directory, "torplay.env") };
  try {
    const imported = await importDefinition("https://definitions.example/unreachable.yml", {
      request: async (url) => response(url, stringify({ ...definition, id: "unreachable-fixture" })),
    });
    let confirmation;
    await assert.rejects(createCardigannProvider({
      importId: imported.importId,
      settings: { token: "private", safe: true },
    }, {
      environment,
      request: async () => { throw Object.assign(new Error("private resolver details"), { code: "ENOTFOUND" }); },
      now: () => 1_700_000_000_000,
    }), (error) => {
      confirmation = error.confirmationToken;
      return error.code === "CARDIGANN_VERIFICATION_FAILED"
        && error.canAddUnverified === true
        && error.verificationFailure.code === "REMOTE_DNS_FAILED"
        && !JSON.stringify(error).includes("private resolver details");
    });
    assert.deepEqual(readCustomProviders(environment), []);
    await assert.rejects(createCardigannProvider({
      importId: imported.importId,
      settings: { token: "changed", safe: true },
      addUnverified: true,
      confirmationToken: confirmation,
    }, { environment }), (error) => error.code === "CARDIGANN_VERIFICATION_CONFIRMATION_INVALID");

    const [saved] = await createCardigannProvider({
      importId: imported.importId,
      settings: { token: "private", safe: true },
      addUnverified: true,
      confirmationToken: confirmation,
    }, { environment, now: () => 1_700_000_000_000 });
    assert.equal(saved.verification.status, "unverified");
    assert.equal(saved.verification.code, "REMOTE_DNS_FAILED");
    assert.equal(JSON.stringify(saved).includes("private"), false);

    const retested = await testCardigannProviderConnection({ id: saved.id }, {
      environment,
      request: async (url) => response(url, '<article class="result"><span class="title">Sintel</span><a href="magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa">Get</a></article>'),
      now: () => 1_700_000_001_000,
    });
    assert.equal(retested.verification.status, "verified");
    assert.equal(readCustomProviders(environment)[0].verification.status, "verified");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("public definitions without settings preview as requiring no configuration", async () => {
  const imported = await importDefinition("https://definitions.example/public.yml", {
    request: async (url) => response(url, stringify({ ...definition, settings: [] })),
  });
  assert.deepEqual(imported.definition.settings, []);
  assert.equal(imported.definition.access, "public");
  assert.equal(imported.definition.website, "https://indexer.example/");
  assert.equal(imported.definition.sourceUrl, "https://definitions.example/public.yml");
});

test("legacy parsed-only Cardigann records remain readable and canonicalize on save", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "torplay-cardigann-legacy-"));
  const environment = { TORPLAY_CONFIG_PATH: path.join(directory, "torplay.env") };
  const filename = path.join(directory, "torrent-providers.json");
  try {
    await writeFile(filename, JSON.stringify([{
      id: "cardigann-legacy", kind: "cardigann", name: definition.name,
      definitionUrl: "https://definitions.example/legacy.yml", definitionHash: "legacy",
      definition, settings: { token: "stored", safe: true }, enabled: true,
      capabilities: { mediaTypes: ["Movies", "TV"], modes: definition.caps.modes },
    }]));
    assert.equal(readCustomProviders(environment)[0].definition.id, "example");
    await updateCardigannProvider({ id: "cardigann-legacy", enabled: false }, { environment });
    const stored = JSON.parse(await readFile(filename, "utf8"));
    assert.equal(stored.providers[0].definitionSourceFormat, "canonicalized-legacy");
    assert.match(stored.providers[0].definitionYaml, /^id: example/m);
    assert.match(stored.providers[0].definitionHash, /^[a-f\d]{64}$/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
