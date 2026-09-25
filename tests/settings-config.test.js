import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  SettingsError,
  configurationWritable,
  parseSettingsEnvironment,
  playbackPreferences,
  settingsState,
  updatePlaybackPreferences,
  updateProviderSettings,
  validateAndUpdateProvidersSettings,
} from "../lib/settings/config.js";

async function fixture(source = "") {
  const directory = await mkdtemp(path.join(os.tmpdir(), "torplay-settings-"));
  const filename = path.join(directory, ".env.local");
  if (source !== null) await writeFile(filename, source, "utf8");
  return { directory, filename };
}

test("parses supported environment assignments without exposing comments", () => {
  assert.deepEqual(parseSettingsEnvironment([
    "# Settings",
    "TMDB_API_TOKEN='token value'",
    " FLARESOLVERR_URL = http://localhost:8191 ",
    "lowercase=ignored",
  ].join("\n")), {
    TMDB_API_TOKEN: "token value",
    FLARESOLVERR_URL: "http://localhost:8191",
  });
});

test("shared playback switches default off and persist independently", async () => {
  const { directory, filename } = await fixture("# Preserve me\n");
  const environment = { TORPLAY_CONFIG_PATH: filename };
  try {
    assert.deepEqual(playbackPreferences(environment), {
      autoSkipIntrosRecaps: false, autoPlayNextEpisode: false,
    });
    await updatePlaybackPreferences({ autoSkipIntrosRecaps: true, autoPlayNextEpisode: false },
      { environment, configPath: filename });
    assert.deepEqual(playbackPreferences(environment), {
      autoSkipIntrosRecaps: true, autoPlayNextEpisode: false,
    });
    assert.match(await readFile(filename, "utf8"), /TORPLAY_AUTO_SKIP_INTRO_RECAP=true/);
    assert.match(await readFile(filename, "utf8"), /# Preserve me/);
    await assert.rejects(updatePlaybackPreferences({ autoSkipIntrosRecaps: "yes", autoPlayNextEpisode: true },
      { environment, configPath: filename }), SettingsError);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("updates FlareSolverr settings atomically while preserving legacy configuration", async () => {
  const { directory, filename } = await fixture("# Keep this comment\nUNRELATED=value\nJACKETT_URL=http://localhost:9117\nJACKETT_API_KEY=old-secret\n");
  const environment = {
    TORPLAY_CONFIG_PATH: filename,
    JACKETT_API_KEY: "old-secret",
    JACKETT_URL: "http://localhost:9117",
  };
  try {
    const result = await updateProviderSettings("flaresolverr", {
      values: { url: "http://127.0.0.1:8191/" },
    }, { environment, configPath: filename });

    assert.deepEqual(result, { providerId: "flaresolverr", restartRequired: false });
    const source = await readFile(filename, "utf8");
    assert.match(source, /^# Keep this comment$/m);
    assert.match(source, /^UNRELATED=value$/m);
    assert.match(source, /^JACKETT_API_KEY=old-secret$/m);
    assert.match(source, /^JACKETT_URL=http:\/\/localhost:9117$/m);
    assert.match(source, /^FLARESOLVERR_URL=http:\/\/127\.0\.0\.1:8191$/m);
    assert.equal(environment.JACKETT_API_KEY, "old-secret");
    assert.equal(environment.FLARESOLVERR_URL, "http://127.0.0.1:8191");
    if (process.platform !== "win32") assert.equal((await stat(filename)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("OMDb changes take effect without a runtime restart", async () => {
  const { directory, filename } = await fixture("");
  const environment = { TORPLAY_CONFIG_PATH: filename };
  try {
    const result = await updateProviderSettings("omdb", {
      values: { apiKey: "omdb-secret" },
    }, { environment, configPath: filename });
    assert.deepEqual(result, { providerId: "omdb", restartRequired: false });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Jackett service URL and key are saved without exposing the key", async () => {
  const { directory, filename } = await fixture("");
  const environment = { TORPLAY_CONFIG_PATH: filename };
  try {
    await updateProviderSettings("jackett", { values: { url: "http://localhost:9117", apiKey: "private-jackett-key" } }, { environment, configPath: filename });
    const state = await settingsState({ environment, includeValues: true });
    const jackett = state.providers.find((item) => item.id === "jackett");
    assert.equal(jackett.configured, true);
    assert.equal(jackett.fields.find((item) => item.id === "url").value, "http://localhost:9117");
    assert.equal(JSON.stringify(state).includes("private-jackett-key"), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("removes secrets explicitly and never returns their values", async () => {
  const { directory, filename } = await fixture("TMDB_API_TOKEN=very-secret-token\n");
  const environment = { TORPLAY_CONFIG_PATH: filename, TMDB_API_TOKEN: "very-secret-token" };
  try {
    const before = await settingsState({ environment, includeValues: true });
    const tokenField = before.providers.find(({ id }) => id === "tmdb").fields[0];
    assert.equal(tokenField.configured, true);
    assert.equal("value" in tokenField, false);
    assert.equal(JSON.stringify(before).includes("very-secret-token"), false);

    await updateProviderSettings("tmdb", { remove: ["apiToken"] }, { environment, configPath: filename });
    assert.equal((await readFile(filename, "utf8")).includes("TMDB_API_TOKEN"), false);
    assert.equal("TMDB_API_TOKEN" in environment, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects externally managed, malformed, and unsupported values", async () => {
  const { directory, filename } = await fixture("");
  try {
    await assert.rejects(
      updateProviderSettings("tmdb", { values: { apiToken: "replacement" } }, {
        environment: {
          TORPLAY_CONFIG_PATH: filename,
          TORPLAY_EXTERNAL_CONFIG_KEYS: "TMDB_API_TOKEN",
          TMDB_API_TOKEN: "host-secret",
        },
        configPath: filename,
      }),
      (error) => error instanceof SettingsError && error.status === 409,
    );
    await assert.rejects(
      updateProviderSettings("flaresolverr", { values: { url: "file:///secret" } }, { environment: {}, configPath: filename }),
      /HTTP or HTTPS/,
    );
    await assert.rejects(updateProviderSettings("jackett", { values: { url: "file:///secret" } }, { environment: {}, configPath: filename }), /HTTP or HTTPS/);
    await assert.rejects(
      updateProviderSettings("tmdb", { values: { apiToken: "0123456789abcdef0123456789abcdef" } }, { environment: {}, configPath: filename }),
      /API Read Access Token/,
    );
    await assert.rejects(
      updateProviderSettings("tmdb", { values: { apiToken: "line one\nline two" } }, { environment: {}, configPath: filename }),
      /single-line/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reports configuration writability without creating a missing parent directory", async () => {
  const { directory, filename } = await fixture(null);
  try {
    assert.equal(await configurationWritable({ environment: { TORPLAY_CONFIG_PATH: filename } }), true);
    const nested = path.join(directory, "missing", "torplay.env");
    assert.equal(await configurationWritable({ environment: { TORPLAY_CONFIG_PATH: nested } }), false);
    await assert.rejects(stat(path.dirname(nested)), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("validates required providers before committing them as one configuration change", async () => {
  const { directory, filename } = await fixture("# preserved\nUNRELATED=value\n");
  const environment = { TORPLAY_CONFIG_PATH: filename };
  const changes = [
    { providerId: "tmdb", payload: { values: { apiToken: "tmdb-token" } } },
  ];
  try {
    const rejected = await validateAndUpdateProvidersSettings(changes, async (candidate) => {
      assert.equal(candidate.TMDB_API_TOKEN, "tmdb-token");
      return { valid: false, results: [{ provider: "tmdb", status: "invalid" }] };
    }, { environment, configPath: filename });
    assert.equal(rejected.committed, false);
    assert.equal(await readFile(filename, "utf8"), "# preserved\nUNRELATED=value\n");
    assert.equal(environment.TMDB_API_TOKEN, undefined);

    const accepted = await validateAndUpdateProvidersSettings(changes, async () => ({ valid: true, results: [] }), {
      environment,
      configPath: filename,
    });
    assert.equal(accepted.committed, true);
    const source = await readFile(filename, "utf8");
    assert.match(source, /^# preserved$/m);
    assert.match(source, /^TMDB_API_TOKEN=tmdb-token$/m);
    assert.equal(environment.TMDB_API_TOKEN, "tmdb-token");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("configuring Jackett service alone does not create a torrent source", async () => {
  const { directory, filename } = await fixture("");
  const environment = {
    TORPLAY_CONFIG_PATH: filename,
    JACKETT_URL: "http://localhost:9117",
    JACKETT_API_KEY: "secret",
  };
  try {
    const state = await settingsState({ environment, includeValues: true });
    assert.deepEqual(state.torrentSources, { nativeActive: false, customActive: false });
    assert.equal(JSON.stringify(state.torrentSources).includes("secret"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
