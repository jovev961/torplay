import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { createCommunityDirectory, communityDirectory } from "../lib/search/community-directory.js";
import { importDefinition } from "../lib/search/cardigann/definition.js";
import { createCardigannProvider, readCustomProviders, customProviderAdapter } from "../lib/settings/torrent-providers.js";
import { POST } from "../app/api/settings/torrent-providers/route.js";
import { settingsState } from "../lib/settings/config.js";

const revision = "a".repeat(40);
const hash = (n) => String(n).repeat(40);
const entry = (name, type = "blob", mode = "100644", sha = hash(4)) => ({ path: name, type, mode, sha });
function directoryFixture() {
  const responses = {
    master: { sha: revision },
    [revision]: { sha: hash(0), truncated: false, tree: [entry("definitions", "tree", "040000", hash(1))] },
    [hash(1)]: { sha: hash(1), truncated: false, tree: [entry("v11", "tree", "040000", hash(2))] },
    [hash(2)]: { sha: hash(2), truncated: false, tree: [entry("zulu.yml"), entry("alpha-source.yaml"), entry("README.md"), entry("link.yml", "blob", "120000"), entry("nested", "tree", "040000", hash(3))] },
    [hash(3)]: { sha: hash(3), truncated: false, tree: [entry("beta.yml")] },
  };
  const calls = [];
  const request = async (url) => {
    calls.push(url);
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
  assert.deepEqual(first.entries.map((item) => item.name), ["alpha source", "beta", "zulu"]);
  assert.equal(first.revision, revision);
  assert.equal(fixture.calls.length, 5);
  await directory.list();
  assert.equal(fixture.calls.length, 5);
  time = 15 * 60 * 1000;
  await directory.list();
  assert.equal(fixture.calls.length, 10);
  await directory.list({ refresh: true });
  assert.equal(fixture.calls.length, 15);
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
  assert.equal((await directory.list()).entries.length, 3);
  await assert.rejects(createCommunityDirectory({ request: async () => ({ status: 200, body: Buffer.from("invalid json") }) }).list(), /invalid response/);
  await assert.rejects(createCommunityDirectory({ request: async () => { throw new Error("sensitive upstream text"); } }).list(), (error) => !error.message.includes("sensitive"));
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
  assert.equal(fixture.calls.length, 5);
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
    yaml = stringify({ ...definition, settings: [{ name: "challenge", type: "info_flaresolverr" }] });
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
    assert.equal(JSON.parse(await readFile(path.join(folder, "torrent-providers.json"), "utf8"))[0].definitionYaml, yaml);
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

test("onboarding source availability respects the Jackett provider override", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "torplay-onboarding-"));
  try {
    const environment = { TORPLAY_CONFIG_PATH: path.join(folder, "config.env"), JACKETT_API_KEY: "configured" };
    assert.equal((await settingsState({ environment })).torrentSources.jackettActive, true);
    assert.equal((await settingsState({ environment: { ...environment, TORPLAY_SEARCH_PROVIDERS: "" } })).torrentSources.jackettActive, false);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
