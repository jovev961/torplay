import assert from "node:assert/strict";
import test from "node:test";
import { stringify } from "yaml";
import { parseDefinition, definitionSettings, settingDescriptors } from "../lib/sources/cardigann/definition.js";
import { searchCardigann } from "../lib/sources/cardigann/engine.js";
import { verifySource } from "../lib/sources/configuration.js";
import { NetworkError } from "../lib/network/request.js";
import { cardigann, definition, response, html, magnet, movie, mockNetwork } from "./helpers/sources-fixtures.js";

for (const kind of ["html", "json", "xml"]) {
  test(`generic Cardigann executes an independent ${kind} definition`, async () => {
    const search = kind === "html" ? definition().search : {
      paths: [{ path: "lookup", response: { type: kind }, inputs: { text: "{{ .Keywords }}" } }],
      rows: { selector: kind === "json" ? "$.entries[*]" : "entry" },
      fields: { title: { selector: kind === "json" ? "name" : "name" }, magnet: { selector: "magnet" } },
    };
    const def = definition({ id: `independent-${kind}`, search });
    assert.equal(parseDefinition(stringify(def)).compatibility.supported, true);
    let requested;
    const rows = await searchCardigann(cardigann(def), movie, { environment: {}, request: async (url) => {
      requested = url;
      const body = kind === "html" ? html() : kind === "json" ? { entries: [{ name: "The Tailor 2023", magnet }] }
        : `<root><entry><name>The Tailor 2023</name><magnet>${magnet}</magnet></entry></root>`;
      return response(body, url);
    } });
    assert.equal(rows.length, 1); assert.equal(rows[0].locator.magnet, magnet);
    assert.ok([...requested.searchParams.values()].includes(movie.title));
  });
}

test("unsupported feature status does not depend on live endpoint verification", () => {
  const def = definition({ certificates: ["synthetic-certificate"] });
  const parsed = parseDefinition(stringify(def), { allowUnsupported: true });
  assert.equal(parsed.compatibility.supported, false);
  assert.throws(() => parseDefinition(stringify(def)), { code: "CARDIGANN_UNSUPPORTED" });
});

test("definition settings enforce completeness and redact secret defaults and values", async () => {
  const def = definition({ type: "private", settings: [{ name: "token", label: "Token", type: "password", default: "sensitive-default" }],
    login: { method: "post", path: "login", inputs: { token: "{{ .Config.token }}" } } });
  const descriptors = settingDescriptors(def, { token: "sensitive-value" });
  assert.equal(descriptors[0].configured, true);
  assert.doesNotMatch(JSON.stringify(descriptors), /sensitive-default|sensitive-value/);
  assert.throws(() => definitionSettings(def, { arbitrary: "value" }), { code: "CONFIGURATION_REQUIRED" });
  const source = cardigann({ ...def, settings: [{ name: "token", type: "password" }] });
  let calls = 0;
  const result = await verifySource(source, { request: () => { calls++; }, environment: {} });
  assert.equal(result.status, "configuration-required"); assert.equal(calls, 0);
});

test("form login uses definition-selected fields, hidden inputs and HTTPS", async () => {
  const def = definition({ type: "private", settings: [{ name: "username", type: "text" }, { name: "password", type: "password" }],
    login: { method: "form", path: "login", form: "#signin", inputs: { user: "{{ .Config.username }}", pass: "{{ .Config.password }}" } } });
  const source = { ...cardigann(def), settings: { username: "fixture-user", password: "fixture-password" } };
  const calls = [];
  const results = await searchCardigann(source, movie, { environment: {}, request: async (url, options) => {
    calls.push({ url, ...options });
    if (url.pathname === "/login") return response('<form id="signin" action="/authenticate"><input name="csrf" value="fixture-csrf"/></form>', url);
    return response(url.pathname === "/authenticate" ? "ok" : html(), url);
  } });
  assert.equal(results.length, 1);
  const submission = calls.find((call) => call.method === "POST");
  assert.equal(submission.url.protocol, "https:");
  assert.deepEqual(Object.fromEntries(new URLSearchParams(submission.body)), { csrf: "fixture-csrf", user: "fixture-user", pass: "fixture-password" });
});

test("current mirrors fail over for connectivity and remember the working mirror", async () => {
  const source = cardigann(definition({ links: ["https://first.example/", "https://second.example/"], legacylinks: ["https://retired.example/"] }));
  const calls = [];
  const options = { request: async (url) => {
    calls.push(url.hostname);
    if (url.hostname === "first.example") throw new NetworkError("REMOTE_CONNECTION_FAILED", "Connection failed.");
    return response(html(), url);
  } };
  assert.equal((await searchCardigann(source, movie, options)).length, 1);
  assert.equal((await searchCardigann(source, movie, options)).length, 1);
  assert.deepEqual(calls, ["first.example", "second.example", "second.example"]);
});

for (const [name, result, expectedCode] of [
  ["zero rows", "<main>No rows</main>", null],
  ["authentication failure", null, "AUTHENTICATION_FAILED"],
  ["invalid JSON", "not JSON", "INVALID_RESPONSE"],
  ["blocked destination", null, "REMOTE_DESTINATION_BLOCKED"],
]) {
  test(`mirror does not fail over after ${name}`, async () => {
    const def = definition({ links: ["https://primary.example/", "https://backup.example/"] });
    if (name === "invalid JSON") def.search.paths[0].response = { type: "json" };
    const calls = [];
    const run = searchCardigann(cardigann(def), movie, { request: async (url) => {
      calls.push(url.hostname);
      if (name === "blocked destination") throw new NetworkError(expectedCode, "Blocked destination.", 400);
      return response(result || "denied", url, name === "authentication failure" ? 401 : 200);
    } });
    if (expectedCode) await assert.rejects(run, { code: expectedCode }); else assert.deepEqual(await run, []);
    assert.deepEqual(calls, ["primary.example"]);
  });
}

test("legacy links are never promoted when all current links fail", async () => {
  const calls = [];
  await assert.rejects(searchCardigann(cardigann(definition({ legacylinks: ["https://legacy.example/"] })), movie, { request: async (url) => {
    calls.push(url.hostname); throw new NetworkError("REMOTE_DNS_FAILED", "DNS failed.");
  } }), { code: "REMOTE_DNS_FAILED" });
  assert.deepEqual(calls, ["fixture.example"]);
});

test("required missing FlareSolverr produces a distinct state before contacting source", async () => {
  const source = cardigann(definition({ settings: [{ name: "solver", type: "info_flaresolverr" }] }));
  let calls = 0;
  await assert.rejects(searchCardigann(source, movie, { environment: {}, request: () => { calls++; } }), { code: "FLARESOLVERR_NOT_CONFIGURED" });
  assert.equal(calls, 0);
  assert.equal((await verifySource(source, { environment: {} })).status, "requires-flaresolverr");
});

test("unmarked definitions remain direct with solver configured and challenge never triggers fallback", async (t) => {
  const calls = mockNetwork(t, () => ({ body: '<title>Just a moment</title><form id="challenge-form"></form>' }));
  await assert.rejects(searchCardigann(cardigann(), movie, { environment: { FLARESOLVERR_URL: "http://127.0.0.1:8191" } }), { code: "SOURCE_UNAVAILABLE" });
  assert.equal(calls.length, 1); assert.equal(calls[0].url.hostname, "fixture.example");
});

test("current mirrors are security-validated rather than trusted after failover", async (t) => {
  const calls = mockNetwork(t, () => { throw Object.assign(new Error("connection failed"), { code: "ECONNREFUSED" }); });
  const dns = await import("node:dns");
  t.mock.method(dns.default, "lookup", (host, _options, callback) => callback(null, [{ address: host === "private.example" ? "127.0.0.1" : "93.184.216.34", family: 4 }]));
  await assert.rejects(searchCardigann(cardigann(definition({ links: ["https://fixture.example/", "https://private.example/"] })), movie), { code: "REMOTE_DESTINATION_BLOCKED" });
  assert.equal(calls.length, 1);
});

test("Cardigann pacing waits remain cancellable", async () => {
  const source = cardigann(definition({ requestDelay: 1 }));
  const controller = new AbortController(); let calls = 0;
  const options = { signal: controller.signal, request: async (url) => { calls++; return response(html(), url); } };
  await searchCardigann(source, movie, options);
  const pending = searchCardigann(source, movie, options);
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(calls, 1);
});
