import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const OMDB_API_URL = "https://www.omdbapi.com/";
export const CONFIGURE_JACKETT_ARGS = [
  "compose",
  "exec",
  "-T",
  "jackett",
  "sh",
  "-c",
  `set -eu
config=/config/Jackett/ServerConfig.json
test -f "$config"
tmp=$(mktemp)
jq -s '.[0] * .[1]' "$config" - > "$tmp"
if cmp -s "$config" "$tmp"; then
  rm -f "$tmp"
  printf unchanged
else
  cat "$tmp" > "$config"
  rm -f "$tmp"
  printf changed
fi`,
];
export const RESTART_JACKETT_ARGS = ["compose", "restart", "jackett"];
export const WAIT_FOR_JACKETT_ARGS = [
  "compose",
  "up",
  "-d",
  "--wait",
  "--wait-timeout",
  "120",
  "jackett",
];

function unquote(value) {
  if (value.length >= 2 && value[0] === value.at(-1) && ['"', "'"].includes(value[0])) {
    return value.slice(1, -1);
  }
  return value;
}

export function readLocalEnvironment(filePath = path.join(process.cwd(), ".env.local")) {
  if (!existsSync(filePath)) return {};
  const values = {};
  for (const rawLine of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const match = rawLine.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    values[match[1]] = unquote(match[2].trim());
  }
  return values;
}

export function jackettConfigurationPatch(environment) {
  const patch = {};
  const omdbKey = environment.OMDB_API_KEY?.trim();
  const hasOmdbKey = Boolean(omdbKey && omdbKey !== "replace-me");
  if (hasOmdbKey) {
    patch.OmdbApiKey = omdbKey;
    patch.OmdbApiUrl = OMDB_API_URL;
  }
  return { patch, hasOmdbKey };
}

function requireSuccessfulResult(result, label) {
  if (result.error) throw new Error(`${label} could not start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status}.`);
}

export function configureJackett({
  dockerCommand,
  spawnSyncProcess = spawnSync,
  environment = readLocalEnvironment(),
  processEnvironment = process.env,
  warn = console.warn,
} = {}) {
  const { patch, hasOmdbKey } = jackettConfigurationPatch(environment);
  if (!hasOmdbKey) {
    warn("OMDB_API_KEY is not configured; preserving Jackett's existing OMDb key.");
  }

  const result = spawnSyncProcess(dockerCommand, CONFIGURE_JACKETT_ARGS, {
    encoding: "utf8",
    env: processEnvironment,
    input: JSON.stringify(patch),
  });
  requireSuccessfulResult(result, "Jackett configuration");

  const changed = result.stdout?.trim() === "changed";
  if (changed) {
    const restart = spawnSyncProcess(dockerCommand, RESTART_JACKETT_ARGS, {
      env: processEnvironment,
      stdio: "inherit",
    });
    requireSuccessfulResult(restart, "Jackett restart");

    const wait = spawnSyncProcess(dockerCommand, WAIT_FOR_JACKETT_ARGS, {
      env: processEnvironment,
      stdio: "inherit",
    });
    requireSuccessfulResult(wait, "Jackett readiness check");
  }

  return { changed, hasOmdbKey };
}
