import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
import { resolvePublicAddress, safeRequest } from "../lib/search/cardigann/http.js";
import { renderTemplate } from "../lib/search/cardigann/template.js";
import { createCardigannProvider, publicCustomProviders, readCustomProviders } from "../lib/settings/torrent-providers.js";

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
  assert.equal(normalizeDefinitionUrl("https://definitions.example/index.yaml"), "https://definitions.example/index.yaml");
  assert.throws(() => normalizeDefinitionUrl("http://definitions.example/index.yml"), /public HTTPS/);
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
    assert.equal(error.unsupportedFeatures[0].feature, "captcha");
  }
  assert.throws(
    () => parseDefinition(stringify({ ...definition, download: { before: { path: "/token" } } })),
    (error) => error.unsupportedFeatures?.some((item) => item.feature === "download.before"),
  );
});

test("definition settings validate options and preserve stored secrets", () => {
  assert.deepEqual(validateDefinitionSettings(definition, { token: "new", safe: false }), { token: "new", safe: false });
  assert.deepEqual(validateDefinitionSettings(definition, { token: "", safe: true }, { token: "stored" }), { token: "stored", safe: true });
  assert.throws(() => validateDefinitionSettings(definition, { token: "x", extra: "no" }), /unknown field/);
});

test("Cardigann templates and filters render supported expressions without evaluation", () => {
  assert.equal(renderTemplate("{{ if eq .Query.Type \"movie-search\" }}movie{{ else }}other{{ end }}", { Query: { Type: "movie-search" } }), "movie");
  assert.equal(renderTemplate("{{ range $item := .Items }}{{$item}},{{ end }}", { Items: ["a", "b"] }), "a,b,");
  assert.equal(applyFilters("SINTÉL", [{ name: "tolower" }, { name: "diacritics" }, { name: "append", args: " 2010" }]), "sintel 2010");
  assert.throws(() => renderTemplate("{{ dangerous .Query }}", {}), /Unsupported Cardigann template function/);
});

test("network guard rejects private resolution and validates every redirect", async () => {
  await assert.rejects(resolvePublicAddress("private.example", (_host, _options, callback) => callback(null, [{ address: "127.0.0.1", family: 4 }])), /public internet/);
  const resolved = await resolvePublicAddress("public.example", (_host, _options, callback) => callback(null, [{ address: "93.184.216.34", family: 4 }]));
  assert.equal(resolved.address, "93.184.216.34");
  const seen = [];
  await assert.rejects(safeRequest("https://public.example/start", {
    requestImpl: async (url) => {
      seen.push(url.toString());
      if (seen.length === 1) return response(url, "", 302, { location: "http://127.0.0.1/private" });
      throw new Error("must not request redirected private target");
    },
  }), /unsupported URL/);
  assert.deepEqual(seen, ["https://public.example/start"]);
  await assert.rejects(safeRequest("https://public.example/start", {
    protocols: ["http:", "https:"],
    requestImpl: async (url) => response(url, "", 302, { location: "http://public.example/insecure" }),
  }), /unsupported URL/);
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

test("imported definitions persist only after live verification and redact settings", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "torplay-cardigann-"));
  const environment = { TORPLAY_CONFIG_PATH: path.join(directory, "torplay.env") };
  try {
    const imported = await importDefinition("https://github.com/example/indexers/blob/main/example.yml", {
      request: async (url) => response(url, stringify(definition)),
    });
    const providers = await createCardigannProvider({ importId: imported.importId, settings: { token: "private", safe: true } }, {
      environment,
      request: async (url) => response(url, '<div class="result"><span class="title">Sintel</span><span class="size">1 MB</span><span class="seeders">1</span><a href="magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa">Get</a></div>'),
    });
    assert.equal(providers[0].kind, "cardigann");
    assert.equal(JSON.stringify(providers).includes("private"), false);
    assert.equal(readCustomProviders(environment)[0].settings.token, "private");
    assert.equal(publicCustomProviders(environment)[0].definitionUrl, "https://github.com/example/indexers/blob/main/example.yml");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
