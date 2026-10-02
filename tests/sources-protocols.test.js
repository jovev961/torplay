import assert from "node:assert/strict";
import test from "node:test";
import dns from "node:dns";
import { gzipSync } from "node:zlib";
import tar from "tar-stream";
import { stringify } from "yaml";
import { verifyTorznab, searchTorznab } from "../lib/sources/torznab.js";
import { searchCardigann } from "../lib/sources/cardigann/engine.js";
import { communityDirectory } from "../lib/sources/community.js";
import { configuredSources } from "../lib/sources/configuration.js";
import { cardigann, definition, response, rss, html, torznab, movie, episode, mockNetwork, settingsFixture } from "./helpers/sources-fixtures.js";

test("generic Torznab verification checks advertised capabilities and a parseable search feed", async () => {
  const calls = [];
  const caps = '<caps><limits max="100"/><searching><search available="yes" supportedParams="q"/><movie-search available="yes" supportedParams="q,imdbid"/><tv-search available="yes" supportedParams="q,season,ep"/></searching><categories><category id="2000"/><category id="5000"/></categories></caps>';
  const capabilities = await verifyTorznab(torznab(), { request: async (url, options) => {
    calls.push({ url, options }); return response(url.searchParams.get("t") === "caps" ? caps : rss(), url);
  } });
  assert.deepEqual(capabilities.mediaTypes, ["Movies", "TV"]);
  assert.deepEqual(capabilities.modes.tvsearch, ["q", "season", "ep"]);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.options.policy === "configured-service" && call.options.sameOrigin === true));
});

test("Torznab episode and season-pack searches use only advertised parameters", async () => {
  const calls = [];
  const source = torznab("fixture", { capabilities: { mediaTypes: ["TV"], modes: { tvsearch: ["q", "season", "ep"] } } });
  await searchTorznab(source, episode, { request: async (url) => { calls.push(Object.fromEntries(url.searchParams)); return response("<rss><channel/></rss>"); } });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].season, "2"); assert.equal(calls[0].ep, "3");
  assert.equal(calls[1].season, "2"); assert.equal(calls[1].ep, undefined);
  assert.equal(calls[0].t, "tvsearch");
});

test("Torznab XML entities, malformed feeds and authentication errors fail safely", async () => {
  for (const [body, code] of [["<!DOCTYPE rss [<!ENTITY secret SYSTEM 'file:///private'>]><rss/>", "INVALID_RESPONSE"],
    ["<rss>", "INVALID_RESPONSE"], ["<html/>", "INVALID_RESPONSE"], ["<error code='100' description='fixture-secret'/>", "AUTHENTICATION_FAILED"]]) {
    await assert.rejects(searchTorznab(torznab(), movie, { request: async () => response(body) }), (error) => {
      assert.equal(error.code, code); assert.ok(!error.message.includes("fixture-secret")); return true;
    });
  }
});

test("explicitly marked Cardigann sends transport to configured local solver only", async (t) => {
  const calls = mockNetwork(t, (call) => ({ body: JSON.stringify({ status: "ok", solution: {
    url: JSON.parse(call.body).url, status: 200, response: html(), headers: {}, cookies: [],
  } }) }));
  t.mock.method(dns, "lookup", (host, _options, callback) => callback(null, [{ address: host === "solver.local" ? "127.0.0.1" : "93.184.216.34", family: 4 }]));
  const source = cardigann(definition({ settings: [{ name: "solver", type: "info_flaresolverr" }] }));
  const results = await searchCardigann(source, movie, { environment: { FLARESOLVERR_URL: "http://solver.local:8191" } });
  assert.equal(results.length, 1);
  assert.equal(calls.length, 1); assert.equal(calls[0].url.hostname, "solver.local");
  assert.equal(calls[0].url.pathname, "/v1");
  assert.equal(JSON.parse(calls[0].body).cmd, "request.get");
  assert.equal(new URL(JSON.parse(calls[0].body).url).hostname, "fixture.example");
});

test("solver final destinations and endpoint are independently security-validated", async (t) => {
  const calls = mockNetwork(t, () => ({ body: JSON.stringify({ status: "ok", solution: { url: "https://private.example/", status: 200, response: html() } }) }));
  t.mock.method(dns, "lookup", (host, _options, callback) => callback(null, [{ address: ["solver.local", "private.example"].includes(host) ? "127.0.0.1" : "93.184.216.34", family: 4 }]));
  const source = cardigann(definition({ settings: [{ name: "solver", type: "info_flaresolverr" }] }));
  await assert.rejects(searchCardigann(source, movie, { environment: { FLARESOLVERR_URL: "http://solver.local:8191" } }), { code: "REMOTE_DESTINATION_BLOCKED" });
  assert.equal(calls.length, 1);
  await assert.rejects(searchCardigann(source, movie, { environment: { FLARESOLVERR_URL: "https://public.example/" } }), { code: "REMOTE_DESTINATION_BLOCKED" });
  assert.equal(calls.length, 1);
});

async function archive(entries) {
  const pack = tar.pack();
  for (const [filename, contents] of entries) pack.entry({ name: `fixture-root/${filename}` }, contents);
  pack.finalize(); const chunks = [];
  for await (const chunk of pack) chunks.push(chunk);
  return gzipSync(Buffer.concat(chunks));
}

test("community directory is opt-in metadata, revision-pinned, cached and never enables sources", async (t) => {
  const fixture = await settingsFixture(t);
  const revision = "a".repeat(40);
  const filename = "definitions/v11/neutral.yml";
  const yaml = stringify(definition()); const compressed = await archive([[filename, yaml]]);
  const calls = mockNetwork(t, ({ url }) => {
    if (url.pathname.includes("/commits/")) return { body: JSON.stringify({ sha: revision }) };
    if (url.pathname.includes("/git/trees/")) return { body: JSON.stringify({ tree: [{ type: "blob", path: filename }] }) };
    if (url.hostname === "codeload.github.com") return { body: compressed };
    return { body: yaml };
  });
  assert.equal(calls.length, 0);
  const snapshot = await communityDirectory.list({ refresh: true });
  assert.equal(snapshot.entries.length, 1); assert.equal(snapshot.entries[0].compatibility, "supported");
  assert.ok(!Object.hasOwn(snapshot.entries[0], "definition"));
  await communityDirectory.list(); assert.equal(calls.length, 3);
  const imported = await communityDirectory.importEntry({ id: "neutral.yml", revision });
  assert.equal(imported.compatibility.supported, true);
  assert.ok(calls.at(-1).url.pathname.includes(revision));
  assert.deepEqual(configuredSources(fixture.environment), []);
  await assert.rejects(communityDirectory.importEntry({ id: "../private.yml", revision }), { code: "COMMUNITY_INVALID" });
  await assert.rejects(communityDirectory.importEntry({ id: "neutral.yml", revision: "b".repeat(40) }), { code: "COMMUNITY_EXPIRED" });
});

test("community archive rejects unsafe/incomplete responses without leaking provider errors", async (t) => {
  mockNetwork(t, () => ({ body: JSON.stringify({ sha: "invalid-token-fixture" }) }));
  await assert.rejects(communityDirectory.list({ refresh: true }), (error) => {
    assert.equal(error.code, "COMMUNITY_INVALID"); assert.ok(!error.message.includes("invalid-token-fixture")); return true;
  });
});
