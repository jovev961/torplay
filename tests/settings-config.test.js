import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  SettingsError,
  configurationWritable,
  parseSettingsEnvironment,
  settingsState,
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
    " JACKETT_URL = http://localhost:9117 ",
    "lowercase=ignored",
  ].join("\n")), {
    TMDB_API_TOKEN: "token value",
    JACKETT_URL: "http://localhost:9117",
  });
});

test("updates provider settings atomically while preserving unrelated configuration", async () => {
  const { directory, filename } = await fixture("# Keep this comment\nUNRELATED=value\nJACKETT_URL=http://localhost:9117\nJACKETT_API_KEY=old-secret\n");
  const environment = {
    TORPLAY_CONFIG_PATH: filename,
    JACKETT_API_KEY: "old-secret",
    JACKETT_URL: "http://localhost:9117",
  };
  try {
    const result = await updateProviderSettings("jackett", {
      values: {
        url: "http://127.0.0.1:9117/",
        apiKey: "",
        movieIndexers: " public-domain, archive_org,public-domain ",
      },
      remove: ["showIndexers"],
    }, { environment, configPath: filename });

    assert.deepEqual(result, { providerId: "jackett", restartRequired: false });
    const source = await readFile(filename, "utf8");
    assert.match(source, /^# Keep this comment$/m);
    assert.match(source, /^UNRELATED=value$/m);
    assert.match(source, /^JACKETT_API_KEY=old-secret$/m);
    assert.match(source, /^JACKETT_URL=http:\/\/127\.0\.0\.1:9117$/m);
    assert.match(source, /^JACKETT_MOVIE_INDEXERS=public-domain,archive_org$/m);
    assert.equal(environment.JACKETT_API_KEY, "old-secret");
    assert.equal(environment.JACKETT_URL, "http://127.0.0.1:9117");
    if (process.platform !== "win32") assert.equal((await stat(filename)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
      updateProviderSettings("jackett", { values: { url: "file:///secret" } }, { environment: {}, configPath: filename }),
      /HTTP or HTTPS/,
    );
    await assert.rejects(
      updateProviderSettings("jackett", { values: { movieIndexers: "valid,bad id" } }, { environment: {}, configPath: filename }),
      /invalid indexer ID/,
    );
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
    { providerId: "jackett", payload: { values: { url: "http://localhost:9117", apiKey: "jackett-token" } } },
  ];
  try {
    const rejected = await validateAndUpdateProvidersSettings(changes, async (candidate) => {
      assert.equal(candidate.TMDB_API_TOKEN, "tmdb-token");
      assert.equal(candidate.JACKETT_API_KEY, "jackett-token");
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
    assert.match(source, /^JACKETT_API_KEY=jackett-token$/m);
    assert.equal(environment.TMDB_API_TOKEN, "tmdb-token");
    assert.equal(environment.JACKETT_API_KEY, "jackett-token");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
