import { normalizeStunUrls } from "./protocol.js";

export const DEFAULT_WATCH_TOGETHER_STUN_URLS = Object.freeze([
  "stun:stun.cloudflare.com:3478",
  "stun:stun.l.google.com:19302",
]);

function configured(value) {
  const normalized = String(value || "").trim();
  return normalized && normalized !== "replace-me" ? normalized : "";
}

export function normalizeSignalingBaseUrl(value) {
  let url;
  try { url = new URL(String(value || "").trim()); }
  catch { throw new Error("Watch Together signaling must be a valid HTTP or HTTPS base URL."); }
  const loopback = new Set(["localhost", "127.0.0.1", "::1"]).has(url.hostname);
  if ((!loopback && url.protocol !== "https:") || (loopback && !["http:", "https:"].includes(url.protocol))
    || url.username || url.password || url.search || url.hash) {
    throw new Error("Watch Together signaling must use HTTPS without credentials, a query, or a fragment.");
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  return url.toString().replace(/\/$/, "");
}

export function watchTogetherConfiguration(environment = process.env) {
  const rawBaseUrl = configured(environment.WATCH_TOGETHER_SIGNAL_URL);
  if (!rawBaseUrl) return { enabled: false, signalUrl: null, stunUrls: DEFAULT_WATCH_TOGETHER_STUN_URLS };
  const baseUrl = normalizeSignalingBaseUrl(rawBaseUrl);
  const websocket = new URL(baseUrl);
  websocket.protocol = websocket.protocol === "https:" ? "wss:" : "ws:";
  websocket.pathname = `${websocket.pathname.replace(/\/$/, "")}/signal`;
  const stunUrls = configured(environment.WATCH_TOGETHER_STUN_URLS)
    ? normalizeStunUrls(environment.WATCH_TOGETHER_STUN_URLS)
    : DEFAULT_WATCH_TOGETHER_STUN_URLS;
  return { enabled: true, baseUrl, signalUrl: websocket.toString(), stunUrls };
}

export function signalingHealthUrl(value) {
  const url = new URL(normalizeSignalingBaseUrl(value));
  url.pathname = `${url.pathname.replace(/\/$/, "")}/health`;
  return url.toString();
}
