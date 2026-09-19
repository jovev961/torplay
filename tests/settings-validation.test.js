import assert from "node:assert/strict";
import test from "node:test";
import {
  clearSettingsValidation,
  validateSettingsProviders,
} from "../lib/settings/validation.js";

function response(body, { status = 200, headers } = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
}

test("returns safe missing and unconfigured states without making requests", async () => {
  let requests = 0;
  const results = await validateSettingsProviders(["tmdb", "omdb", "opensubtitles", "subdl"], {
    environment: {},
    fetchImpl: async () => { requests += 1; },
    useCache: false,
  });
  assert.deepEqual(results.map(({ status }) => status), ["missing", "unconfigured", "unconfigured", "unconfigured"]);
  assert.equal(requests, 0);
});

test("validates configured providers without including credentials in results", async () => {
  const secrets = ["tmdb-secret", "jackett-secret", "omdb-secret", "open-secret", "subdl-secret"];
  const results = await validateSettingsProviders(undefined, {
    environment: {
      TMDB_API_TOKEN: secrets[0],
      JACKETT_URL: "http://localhost:9117",
      JACKETT_API_KEY: secrets[1],
      OMDB_API_KEY: secrets[2],
      OPENSUBTITLES_API_KEY: secrets[3],
      SUBDL_API_KEY: secrets[4],
    },
    fetchImpl: async (url) => {
      const value = String(url);
      if (value.includes("jackett" ) || value.includes("localhost:9117")) return response("<caps></caps>");
      if (value.includes("omdbapi")) return response({ Response: "True" });
      if (value.includes("subdl")) return response({ status: true });
      return response({ data: [] });
    },
    useCache: false,
  });
  assert.deepEqual(results.map(({ status }) => status), ["valid", "valid", "valid", "valid", "valid"]);
  const serialized = JSON.stringify(results);
  for (const secret of secrets) assert.equal(serialized.includes(secret), false);
});

test("distinguishes rejected credentials and unreachable services", async () => {
  const invalid = await validateSettingsProviders(["tmdb"], {
    environment: { TMDB_API_TOKEN: "bad-token" },
    fetchImpl: async () => response({}, { status: 401 }),
    useCache: false,
  });
  assert.equal(invalid[0].status, "invalid");

  const unreachable = await validateSettingsProviders(["tmdb"], {
    environment: { TMDB_API_TOKEN: "token" },
    fetchImpl: async () => { throw new Error("offline"); },
    useCache: false,
  });
  assert.equal(unreachable[0].status, "unreachable");
});

test("caches validation briefly and rejects malformed provider selections", async () => {
  clearSettingsValidation("tmdb");
  let calls = 0;
  const options = {
    environment: { TMDB_API_TOKEN: "token" },
    fetchImpl: async () => { calls += 1; return response({}); },
    now: 1_000,
  };
  await validateSettingsProviders(["tmdb"], options);
  await validateSettingsProviders(["tmdb"], { ...options, now: 2_000 });
  assert.equal(calls, 1);
  await assert.rejects(validateSettingsProviders("tmdb"), /must be an array/);
  await assert.rejects(validateSettingsProviders(["unknown"]), /unknown provider/);
});
