import { knabenProvider } from "./knaben.js";
import { ytsProvider } from "./yts.js";
import { eztvProvider } from "./eztv.js";

export const NATIVE_PROVIDERS = [knabenProvider, ytsProvider, eztvProvider];
export const NATIVE_PROVIDER_IDS = NATIVE_PROVIDERS.map((provider) => provider.id);

export function nativeProvider(id) {
  return NATIVE_PROVIDERS.find((provider) => provider.id === id) || null;
}

export function providerIds(value) {
  return [...new Set(String(value ?? "").split(",").map((id) => id.trim()).filter(Boolean))];
}

export function selectedNativeProviderIds(environment = process.env) {
  if (environment.TORPLAY_SEARCH_PROVIDERS !== undefined) {
    return providerIds(environment.TORPLAY_SEARCH_PROVIDERS).filter((id) => NATIVE_PROVIDER_IDS.includes(id));
  }
  if (environment.TORPLAY_NATIVE_PROVIDERS !== undefined) {
    return providerIds(environment.TORPLAY_NATIVE_PROVIDERS);
  }
  return [];
}

export function configuredNativeProviderIds(environment = process.env) {
  if (environment.TORPLAY_SEARCH_PROVIDERS !== undefined) {
    return selectedNativeProviderIds(environment);
  }
  if (environment.TORPLAY_CONFIGURED_NATIVE_PROVIDERS !== undefined) {
    return providerIds(environment.TORPLAY_CONFIGURED_NATIVE_PROVIDERS);
  }
  return selectedNativeProviderIds(environment);
}

export function jackettIsConfigured(environment = process.env) {
  const apiKey = String(environment.JACKETT_API_KEY || "").trim();
  return Boolean(apiKey && apiKey !== "replace-me" && String(environment.JACKETT_URL || "").trim());
}
