import packageJson from "../../package.json" with { type: "json" };
import { configurationWritable, settingsState } from "../../lib/settings/config.js";
import { setupStatusFromProviders } from "../../lib/settings/readiness.js";
import { publicCustomProviders } from "../../lib/settings/torrent-providers.js";
import { readRuntimeStatus } from "../../platform/runtime/status.js";

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
    setup: setupStatusFromProviders(state.providers),
    runtime: {
      mode: environment.TORPLAY_CONFIG_PATH ? "Installed Windows runtime" : "Development or source runtime",
      configurationWritable: await configurationWritable({ environment, cwd }),
      components: runtimeComponents(environment),
    },
    torrentSources: state.torrentSources,
    customProviders: publicCustomProviders(environment, canEdit),
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
