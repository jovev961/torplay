import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CONFIGURE_JACKETT_ARGS,
  FLARESOLVERR_URL,
  OMDB_API_URL,
  RESTART_JACKETT_ARGS,
  WAIT_FOR_JACKETT_ARGS,
  configureJackett,
  jackettConfigurationPatch,
  readLocalEnvironment,
} from "../scripts/jackett-config.js";

test("reads quoted values from the local environment file", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "torplay-env-"));
  const filePath = path.join(directory, ".env.local");
  try {
    writeFileSync(filePath, "OMDB_API_KEY='secret-key'\nIGNORED=value\n", "utf8");
    assert.equal(readLocalEnvironment(filePath).OMDB_API_KEY, "secret-key");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("builds FlareSolverr and OMDb settings without changing the timeout", () => {
  assert.deepEqual(jackettConfigurationPatch({ OMDB_API_KEY: "omdb-secret" }), {
    patch: {
      FlareSolverrUrl: FLARESOLVERR_URL,
      OmdbApiKey: "omdb-secret",
      OmdbApiUrl: OMDB_API_URL,
    },
    hasOmdbKey: true,
  });
  assert.equal("FlareSolverrMaxTimeout" in jackettConfigurationPatch({}).patch, false);
});

test("preserves an existing OMDb key when the environment key is absent or placeholder", () => {
  for (const value of [undefined, "", "replace-me"]) {
    const { patch, hasOmdbKey } = jackettConfigurationPatch({ OMDB_API_KEY: value });
    assert.equal(hasOmdbKey, false);
    assert.equal("OmdbApiKey" in patch, false);
    assert.equal(patch.FlareSolverrUrl, FLARESOLVERR_URL);
  }
});

test("sends secrets through stdin and restarts Jackett only after a change", () => {
  const calls = [];
  const spawnSyncProcess = (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0, stdout: calls.length === 1 ? "changed" : "" };
  };

  const result = configureJackett({
    dockerCommand: "docker",
    spawnSyncProcess,
    environment: { OMDB_API_KEY: "omdb-secret" },
    processEnvironment: { PATH: "/test" },
  });

  assert.deepEqual(result, { changed: true, hasOmdbKey: true });
  assert.deepEqual(calls[0].args, CONFIGURE_JACKETT_ARGS);
  assert.equal(calls[0].options.input.includes("omdb-secret"), true);
  assert.equal(JSON.stringify(calls[0].args).includes("omdb-secret"), false);
  assert.deepEqual(calls[1].args, RESTART_JACKETT_ARGS);
  assert.deepEqual(calls[2].args, WAIT_FOR_JACKETT_ARGS);
});

test("does not restart Jackett when synchronized settings are unchanged", () => {
  const calls = [];
  const warnings = [];
  const spawnSyncProcess = (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0, stdout: "unchanged" };
  };

  const result = configureJackett({
    dockerCommand: "docker",
    spawnSyncProcess,
    environment: {},
    warn: (message) => warnings.push(message),
  });

  assert.deepEqual(result, { changed: false, hasOmdbKey: false });
  assert.equal(calls.length, 1);
  assert.equal(warnings.length, 1);
});
