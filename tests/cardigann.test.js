import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stringify } from "yaml";
import { cardigannAdapter } from "../lib/search/cardigann/engine.js";
import {
  importDefinition,
  normalizeDefinitionUrl,
  parseDefinition,
  validateDefinitionSettings,
} from "../lib/search/cardigann/definition.js";
import { applyFilters } from "../lib/search/cardigann/filters.js";
import { pinnedLookup, resolvePublicAddress, safeRequest } from "../lib/search/cardigann/http.js";
import { renderTemplate } from "../lib/search/cardigann/template.js";
import { createCardigannProvider, publicCustomProviders, readCustomProviders, updateCardigannProvider } from "../lib/settings/torrent-providers.js";

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
    normalizeDefinitionUrl("https://github.com/Prowlarr/Indexers/blob/master/definitions/v11/yts.yml#readme"),
    "https://raw.githubusercontent.com/Prowlarr/Indexers/master/definitions/v11/yts.yml",
  );
  assert.equal(
    normalizeDefinitionUrl("https://raw.githubusercontent.com/Prowlarr/Indexers/master/definitions/v11/yts.yml"),
    "https://raw.githubusercontent.com/Prowlarr/Indexers/master/definitions/v11/yts.yml",
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
  assert.throws(() => parseDefinition(stringify({
    ...definition,
    settings: [{ name: "info_flaresolverr", type: "info_flaresolverr" }],
  })), (error) => error.code === "CARDIGANN_UNSUPPORTED"
    && error.unsupportedFeatures[0].path === "definition.settings[0]");
});

test("definition settings validate options and preserve stored secrets", () => {
  assert.deepEqual(validateDefinitionSettings(definition, { token: "new", safe: false }), { token: "new", safe: false });
  assert.deepEqual(validateDefinitionSettings(definition, { token: "", safe: true }, { token: "stored" }), { token: "stored", safe: true });
  assert.throws(() => validateDefinitionSettings(definition, { token: "x", extra: "no" }), /unknown field/);
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
  const blobUrl = "https://github.com/Prowlarr/Indexers/blob/master/definitions/v11/yts.yml";
  const rawUrl = "https://raw.githubusercontent.com/Prowlarr/Indexers/master/definitions/v11/yts.yml";
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
      website: "https://indexer.example/",
      sourceUrl: "https://github.com/example/indexers/blob/main/example.yml",
      settings: [
        { name: "token", label: "Token", type: "password", options: null, default: null, required: true, secret: true, configured: false },
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
    assert.equal(stored[0].definitionYaml, definitionYaml);
    assert.equal(stored[0].definitionSourceFormat, "original");
    assert.equal(publicCustomProviders(environment)[0].definitionUrl, "https://github.com/example/indexers/blob/main/example.yml");
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
    assert.equal(stored[0].definitionSourceFormat, "canonicalized-legacy");
    assert.match(stored[0].definitionYaml, /^id: example/m);
    assert.match(stored[0].definitionHash, /^[a-f\d]{64}$/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
