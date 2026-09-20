import { SettingsError } from "./config.js";
import { isPrivateNetworkAddress } from "../network/private-address.js";

function firstHeaderValue(value) {
  return String(value || "").split(",")[0].trim();
}

function requestHost(request) {
  return firstHeaderValue(request.headers.get("x-forwarded-host"))
    || firstHeaderValue(request.headers.get("host"));
}

function hostname(value) {
  try {
    return new URL(`http://${value}`).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return "";
  }
}

function publicHostname(environment) {
  const configured = String(environment.TORPLAY_PUBLIC_HOSTNAME || "").trim().toLowerCase();
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.local$/.test(configured)
    ? configured
    : "torplay.local";
}

export function isLocalNetworkSettingsRequest(request, { environment = process.env } = {}) {
  const requestHostname = hostname(requestHost(request));
  const trustedHost = requestHostname === "localhost"
    || requestHostname === publicHostname(environment)
    || isPrivateNetworkAddress(requestHostname);
  if (!trustedHost) return false;

  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor === null) return true;
  return forwardedFor
    .split(",")
    .map((address) => address.trim())
    .every((address) => address && isPrivateNetworkAddress(address));
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

export function assertSettingsMutationRequest(request, options) {
  if (!isLocalNetworkSettingsRequest(request, options)) {
    throw new SettingsError("Settings can only be changed through TorPlay on the private local network.", 403);
  }
  assertSameOriginSettingsRequest(request);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new SettingsError("Settings requests must use JSON.", 415);
  }
}
