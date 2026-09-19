import { SettingsError } from "./config.js";

function requestHost(request) {
  return request.headers.get("x-forwarded-host") || request.headers.get("host") || "";
}

function hostname(value) {
  try {
    return new URL(`http://${value}`).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return "";
  }
}

function loopbackAddress(value) {
  const address = String(value || "").trim().replace(/^::ffff:/i, "").toLowerCase();
  return ["127.0.0.1", "::1"].includes(address);
}

export function isLoopbackSettingsRequest(request) {
  if (!["localhost", "127.0.0.1", "::1"].includes(hostname(requestHost(request)))) return false;
  const forwardedFor = request.headers.get("x-forwarded-for");
  return !forwardedFor || forwardedFor.split(",").every(loopbackAddress);
}

export function assertSameOriginSettingsRequest(request) {
  const host = requestHost(request).toLowerCase();
  const origin = request.headers.get("origin");
  let originHost = "";
  try {
    originHost = new URL(origin || "").host.toLowerCase();
  } catch {
    // Handled by the common rejection below.
  }
  if (!host || originHost !== host) {
    throw new SettingsError("Settings requests must come from the same TorPlay origin.", 403);
  }
}

export function assertSettingsMutationRequest(request) {
  if (!isLoopbackSettingsRequest(request)) {
    throw new SettingsError("Settings can only be changed from the TorPlay computer through localhost.", 403);
  }
  assertSameOriginSettingsRequest(request);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new SettingsError("Settings requests must use JSON.", 415);
  }
}
