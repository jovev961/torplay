import packageJson from "../../package.json" with { type: "json" };
import { readRuntimeStatus } from "../../scripts/runtime-status.js";
import { configurationWritable, settingsState } from "./config.js";

const restartKey = Symbol.for("torplay.settingsRestartRequired");

export function requireSettingsRestart() {
  globalThis[restartKey] = true;
}

export function settingsRestartRequired() {
  return Boolean(globalThis[restartKey]);
}

function runtimeComponents(environment) {
  const state = readRuntimeStatus(environment.TORPLAY_STATUS_PATH);
  if (!state?.components) return [];
  return Object.entries(state.components).map(([name, status]) => ({ name, status }));
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

export async function getSettingsSnapshot({
  canEdit,
  environment = process.env,
  cwd = process.cwd(),
} = {}) {
  const state = await settingsState({ environment, cwd, includeValues: canEdit });
  return {
    canEdit,
    restartRequired: settingsRestartRequired(),
    runtime: {
      mode: environment.TORPLAY_CONFIG_PATH ? "Installed Windows runtime" : "Development or source runtime",
      configurationWritable: await configurationWritable({ environment, cwd }),
      components: runtimeComponents(environment),
    },
    providers: state.providers,
    playback: {
      nativeFormats: ["MP4", "M4V", "WebM"],
      hlsAvailable: true,
      bundledMediaTools: true,
      bufferAheadSeconds: positiveNumber(environment.PLAYBACK_BUFFER_AHEAD_SECONDS, 60),
      subtitleCacheDays: positiveNumber(environment.SUBTITLE_CACHE_TTL_DAYS, 30),
    },
    about: {
      version: packageJson.version,
      license: packageJson.license,
      repositoryUrl: "https://github.com/jovev961/torplay",
    },
  };
}
