import { settingsState } from "./config.js";

export function setupStatusFromProviders(providers = []) {
  const missingProviderIds = providers
    .filter((provider) => provider.required && !provider.configured)
    .map((provider) => provider.id);
  return { ready: missingProviderIds.length === 0, missingProviderIds };
}

export async function getSetupStatus(options = {}) {
  const state = await settingsState(options);
  return setupStatusFromProviders(state.providers);
}
