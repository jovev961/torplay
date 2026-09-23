import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import tar from "tar-stream";
import { stringify } from "yaml";
import { createCommunityDirectory, communityDirectory } from "../lib/search/community-directory.js";
import { importDefinition } from "../lib/search/cardigann/definition.js";
import { createCardigannProvider, readCustomProviders, customProviderAdapter } from "../lib/settings/torrent-providers.js";
import { POST } from "../app/api/settings/torrent-providers/route.js";
import { settingsState } from "../lib/settings/config.js";
import { filterCommunityEntries, unexploredCommunityEntries } from "../components/community-source-filters.js";

const revision = "a".repeat(40);
const hash = (n) => String(n).repeat(40);
const entry = (name, type = "blob", mode = "100644", sha = hash(4)) => ({ path: name, type, mode, sha });
async function definitionArchive(omit = []) {
  const pack = tar.pack();
  const definitions = {
    "zulu.yml": { id: "zulu-internal", type: "public", language: "en-US", caps: { categories: { "2000": "Movies" } } },
    "alpha-source.yaml": { id: "alpha", type: "semi-private", language: "en-US", caps: { categories: { "5000": "TV/Anime" } },
      settings: [{ name: "flare", type: "info_flaresolverr" }] },
    "nested/beta.yml": { id: "beta", type: "private", language: "en-US", caps: { categories: { "2000": "Movies", "5000": "TV" } } },
    "anime-public.yml": { id: "anime-public", type: "public", language: "ja-JP", caps: { categories: { "5070": "TV/Anime" } } },
    "audio.yml": { type: "public", language: "en-US", caps: { categories: { "3000": "Audio" } } },
  };
  for (const [name, definition] of Object.entries(definitions)) {
    if (omit.includes(name)) continue;
    pack.entry({ name: `Indexers-${revision}/definitions/v11/${name}` }, stringify(definition));
  }
  pack.finalize();
  const chunks = [];
  for await (const chunk of pack) chunks.push(chunk);
  return gzipSync(Buffer.concat(chunks));
}
function directoryFixture() {
  const responses = {
    master: { sha: revision },
    [revision]: { sha: hash(0), truncated: false, tree: [entry("definitions", "tree", "040000", hash(1))] },
    [hash(1)]: { sha: hash(1), truncated: false, tree: [entry("v11", "tree", "040000", hash(2))] },
    [hash(2)]: { sha: hash(2), truncated: false, tree: [entry("zulu.yml"), entry("alpha-source.yaml"), entry("anime-public.yml"), entry("audio.yml"), entry("README.md"), entry("link.yml", "blob", "120000"), entry("nested", "tree", "040000", hash(3))] },
    [hash(3)]: { sha: hash(3), truncated: false, tree: [entry("beta.yml")] },
  };
  const calls = [];
  const archive = definitionArchive();
  const request = async (url) => {
    calls.push(url);
    if (url.startsWith("https://codeload.github.com/")) return { status: 200, body: await archive };
    assert.match(url, /^https:\/\/api\.github\.com\//);
    return { status: 200, body: Buffer.from(JSON.stringify(responses[url.split("/").at(-1)])) };
  };
  return { responses, calls, request };
}

test("directory is opt-in, metadata-only, sorted, cached and deduplicated", async () => {
  const fixture = directoryFixture();
  let time = 0;
  const directory = createCommunityDirectory({ request: fixture.request, now: () => time });
  assert.equal(fixture.calls.length, 0);
  const [first, same] = await Promise.all([directory.list(), directory.list({ refresh: true })]);
  assert.deepEqual(first, same);
  assert.deepEqual(first.entries.map((item) => item.name), ["alpha source", "anime public", "beta", "zulu"]);
  assert.deepEqual(first.entries.map((item) => item.mediaTypes), [["TV"], ["TV"], ["Movies", "TV"], ["Movies"]]);
  assert.deepEqual(first.entries.map((item) => item.access), ["semi-private", "public", "private", "public"]);
  assert.deepEqual(first.entries.map((item) => item.anime), [true, true, false, false]);
  assert.deepEqual(first.entries.map((item) => item.definitionId), ["alpha", "anime-public", "beta", "zulu-internal"]);
  assert.equal(first.entries[0].requiresFlareSolverr, true);
  assert.equal(JSON.stringify(first).includes("caps"), false);
  assert.equal(first.revision, revision);
  assert.equal(fixture.calls.length, 6);
  await directory.list();
  assert.equal(fixture.calls.length, 6);
  time = 15 * 60 * 1000;
  await directory.list();
  assert.equal(fixture.calls.length, 12);
  await directory.list({ refresh: true });
  assert.equal(fixture.calls.length, 18);
});

test("directory rejects incomplete, malformed and unsafe entries and can retry", async () => {
  for (const value of [
    { sha: hash(2), tree: [], truncated: true },
    { sha: hash(2), tree: "bad", truncated: false },
    { sha: hash(2), tree: [entry("../escape.yml")], truncated: false },
  ]) {
    const fixture = directoryFixture();
    fixture.responses[hash(2)] = value;
    await assert.rejects(createCommunityDirectory({ request: fixture.request }).list(), /invalid|incomplete/);
  }
  let fail = true;
  const fixture = directoryFixture();
  const directory = createCommunityDirectory({ request: (...args) => fail ? { status: 429, body: Buffer.from("secret") } : fixture.request(...args) });
  await assert.rejects(directory.list(), /rate limited/);
  fail = false;
  assert.equal((await directory.list()).entries.length, 4);
  await assert.rejects(createCommunityDirectory({ request: async () => ({ status: 200, body: Buffer.from("invalid json") }) }).list(), /invalid response/);
  await assert.rejects(createCommunityDirectory({ request: async () => { throw new Error("sensitive upstream text"); } }).list(), (error) => !error.message.includes("sensitive"));
});

test("directory rejects a corrupt definition archive without caching it", async () => {
  const fixture = directoryFixture();
  let corrupt = true;
  const directory = createCommunityDirectory({ request: (url, options) => url.startsWith("https://codeload.github.com/") && corrupt
    ? { status: 200, body: Buffer.from("not gzip") }
    : fixture.request(url, options) });
  await assert.rejects(directory.list(), /archive could not be read/);
  corrupt = false;
  assert.equal((await directory.list()).entries.length, 4);
});

test("explore filters anime, access and search while hiding configured Cardigann definitions", async () => {
  const entries = (await createCommunityDirectory({ request: directoryFixture().request }).list()).entries;
  const available = unexploredCommunityEntries(entries, [
    { kind: "cardigann", definitionId: "ZULU-INTERNAL" },
    { kind: "cardigann", definitionUrl: `https://raw.githubusercontent.com/Prowlarr/Indexers/${revision}/definitions/v11/nested/beta.yml` },
    { kind: "torznab", definitionId: "alpha" },
  ]);
  assert.deepEqual(available.map((item) => item.name), ["alpha source", "anime public"]);
  assert.deepEqual(filterCommunityEntries(available, { media: "Anime" }).map((item) => item.name), ["alpha source", "anime public"]);
  assert.deepEqual(filterCommunityEntries(available, { media: "TV", access: "semi-private" }).map((item) => item.name), ["alpha source"]);
  assert.deepEqual(filterCommunityEntries(available, { media: "Anime", access: "public", query: "anime" }).map((item) => item.name), ["anime public"]);
  assert.deepEqual(filterCommunityEntries(available, { access: "private" }), []);
});

test("directory does not silently omit files missing from a pinned archive", async () => {
  const fixture = directoryFixture();
  const partial = await definitionArchive(["zulu.yml"]);
  const directory = createCommunityDirectory({ request: (url, options) => url.startsWith("https://codeload.github.com/")
    ? { status: 200, body: partial }
    : fixture.request(url, options) });
  await assert.rejects(directory.list(), /archive is incomplete/);
});

test("selected entries are resolved server-side and pinned; expired and forged requests cannot import", async () => {
  const fixture = directoryFixture();
  let time = 0;
  const imports = [];
  const directory = createCommunityDirectory({ request: fixture.request, now: () => time, importer: async (url) => { imports.push(url); return { importId: "preview" }; } });
  await assert.rejects(directory.importEntry({ id: "zulu.yml", revision }), /expired/);
  await directory.list();
  for (const id of ["../zulu.yml", "https://example.com/a.yml", "link.yml", "unknown.yml"]) {
    await assert.rejects(directory.importEntry({ id, revision }), /Choose a source/);
  }
  await assert.rejects(directory.importEntry({ id: "zulu.yml", revision: hash(9) }), /expired/);
  assert.equal(imports.length, 0);
  await directory.importEntry({ id: "nested/beta.yml", revision });
  assert.deepEqual(imports, [`https://raw.githubusercontent.com/Prowlarr/Indexers/${revision}/definitions/v11/nested/beta.yml`]);
  time = 15 * 60 * 1000;
  await assert.rejects(directory.importEntry({ id: "zulu.yml", revision }), /expired/);
  assert.equal(fixture.calls.length, 6);
});

const definition = {
  id: "community-fixture", name: "Community Fixture", description: "Generic test", language: "en-US", type: "public", encoding: "UTF-8",
  links: ["https://source.example/"], caps: { categories: { "1": "TV/Anime" }, modes: { search: ["q"] } },
  settings: [{ name: "choice", type: "select", options: { all: "All" }, default: "all" }],
  search: { path: "/search", inputs: { q: "{{ .Keywords }}" }, rows: { selector: ".row" }, fields: { title: { selector: "a" }, category: { text: "TV/Anime" }, size: { text: "1 MB" }, seeders: { text: "1" }, magnet: { selector: "a", attribute: "href" } } },
};
const online = async (url) => ({ status: 200, headers: {}, url: new URL(url), body: Buffer.from('<div class="row"><a href="magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa">Authorized video</a></div>') });

test("community selection uses complete import, compatibility, confirmation, duplicates and standalone execution", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "torplay-community-"));
  const environment = { TORPLAY_CONFIG_PATH: path.join(folder, "config.env") };
  const fixture = directoryFixture();
  let yaml = "# retain full definition\n" + stringify(definition);
  const directory = createCommunityDirectory({ request: fixture.request, importer: (url) => importDefinition(url, { request: async () => ({ status: 200, body: Buffer.from(yaml) }) }) });
  try {
    await directory.list();
    assert.deepEqual(readCustomProviders(environment), []);
    yaml = stringify({ ...definition, login: { method: "post", path: "/login", captcha: { type: "image", selector: "img", input: "captcha" } } });
    await assert.rejects(directory.importEntry({ id: "zulu.yml", revision }), (error) => error.code === "CARDIGANN_UNSUPPORTED");
    yaml = "# retain full definition\n" + stringify(definition);
    const preview = await directory.importEntry({ id: "zulu.yml", revision });
    assert.deepEqual(preview.definition.categories, ["TV/Anime"]);
    assert.equal(preview.definition.settings[0].type, "select");
    assert.deepEqual(readCustomProviders(environment), []);
    const values = { importId: preview.importId, settings: { choice: "all" } };
    await assert.rejects(createCardigannProvider({ ...values, settings: { choice: "wrong" } }, { environment }), /invalid option/);
    let token;
    await assert.rejects(createCardigannProvider(values, { environment, request: async () => { throw Object.assign(new Error("private"), { code: "ETIMEDOUT" }); } }), (error) => {
      token = error.confirmationToken;
      return error.canAddUnverified && error.verificationFailure.code === "REMOTE_REQUEST_TIMEOUT";
    });
    const [saved] = await createCardigannProvider({ ...values, addUnverified: true, confirmationToken: token }, { environment });
    assert.equal(saved.verification.status, "unverified");
    assert.equal(JSON.parse(await readFile(path.join(folder, "torrent-providers.json"), "utf8")).providers[0].definitionYaml, yaml);
    const duplicate = await directory.importEntry({ id: "zulu.yml", revision });
    await assert.rejects(createCardigannProvider({ importId: duplicate.importId, settings: { choice: "all" } }, { environment }), /already configured/);
    const calls = fixture.calls.length;
    const results = await customProviderAdapter(readCustomProviders(environment)[0], { request: online }).search({ title: "Authorized video", type: "show" });
    assert.equal(results.length, 1);
    assert.equal(fixture.calls.length, calls);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("directory API requires same-origin LAN access before any upstream request", async () => {
  const original = communityDirectory.list;
  let calls = 0;
  communityDirectory.list = async () => { calls++; return { entries: [], revision }; };
  try {
    for (const action of ["list-community-definitions", "import-community-definition"]) {
      const denied = await POST(new Request("http://localhost/api/settings/torrent-providers", { method: "POST", headers: { origin: "http://evil.example", "content-type": "application/json" }, body: JSON.stringify({ action }) }));
      assert.equal(denied.status, 403);
    }
    assert.equal(calls, 0);
    const allowed = await POST(new Request("http://localhost/api/settings/torrent-providers", { method: "POST", headers: { host: "localhost", origin: "http://localhost", "content-type": "application/json" }, body: JSON.stringify({ action: "list-community-definitions" }) }));
    assert.equal(allowed.status, 200);
    assert.equal(calls, 1);
  } finally { communityDirectory.list = original; }
});

test("onboarding source availability respects the migrated Jackett provider override", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "torplay-onboarding-"));
  try {
    const environment = { TORPLAY_CONFIG_PATH: path.join(folder, "config.env"), JACKETT_URL: "http://localhost:9117", JACKETT_API_KEY: "configured", JACKETT_MOVIE_INDEXERS: "yts" };
    assert.equal((await settingsState({ environment })).torrentSources.customActive, true);
    assert.equal((await settingsState({ environment: { ...environment, TORPLAY_SEARCH_PROVIDERS: "" } })).torrentSources.customActive, false);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
