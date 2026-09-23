import dns from "node:dns/promises";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { resolvePublicAddress } from "./http.js";

const MAX_RESPONSE_BYTES = 6 * 1024 * 1024;

function failure(code, message, status = 502) {
  return Object.assign(new Error(message), { code, status });
}

function privateAddress(address) {
  try {
    return ["private", "loopback", "linkLocal", "uniqueLocal"].includes(ipaddr.process(address).range());
  } catch { return false; }
}

export function flareSolverrEndpoint(value) {
  let url;
  try { url = new URL(String(value || "")); } catch { throw failure("FLARESOLVERR_URL_INVALID", "Enter a valid FlareSolverr URL.", 400); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || (url.pathname !== "/" && url.pathname !== "/v1")) {
    throw failure("FLARESOLVERR_URL_INVALID", "Use a FlareSolverr HTTP(S) base URL without credentials or query parameters.", 400);
  }
  url.pathname = "/v1";
  return url;
}

export async function validateFlareSolverrEndpoint(value, lookup = dns.lookup) {
  const url = flareSolverrEndpoint(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (hostname === "localhost") return url;
  if (isIP(hostname)) {
    if (privateAddress(hostname)) return url;
  } else {
    const addresses = await lookup(hostname, { all: true });
    if (addresses.length && addresses.every((item) => privateAddress(item.address))) return url;
  }
  throw failure("FLARESOLVERR_URL_BLOCKED", "FlareSolverr must be on this computer or a private LAN address.", 400);
}

export async function requestFlareSolverr(target, {
  endpoint,
  method = "GET",
  body,
  headers = {},
  signal,
  timeoutMs = 65_000,
  maxBytes = 5 * 1024 * 1024,
  fetchImpl = fetch,
  validateTarget = resolvePublicAddress,
  endpointLookup = dns.lookup,
} = {}) {
  const service = await validateFlareSolverrEndpoint(endpoint, endpointLookup);
  const url = new URL(target);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw failure("FLARESOLVERR_TARGET_BLOCKED", "The indexer request URL is invalid.", 400);
  }
  await validateTarget(url.hostname);
  const verb = method.toUpperCase();
  if (!["GET", "POST"].includes(verb) || (verb === "POST" && !/application\/x-www-form-urlencoded/i.test(headers["Content-Type"] || headers["content-type"] || ""))) {
    throw failure("FLARESOLVERR_REQUEST_UNSUPPORTED", "This Cardigann request cannot use FlareSolverr.", 422);
  }
  const extraHeaders = Object.keys(headers).filter((name) => !["cookie", "user-agent", "accept", "content-type"].includes(name.toLowerCase()));
  if (extraHeaders.length) throw failure("FLARESOLVERR_REQUEST_UNSUPPORTED", "This Cardigann request requires headers FlareSolverr cannot send.", 422);
  const cookies = String(headers.Cookie || headers.cookie || "").split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf("=");
    return index < 1 ? null : { name: part.slice(0, index), value: part.slice(index + 1) };
  }).filter(Boolean);
  const payload = { cmd: verb === "POST" ? "request.post" : "request.get", url: url.toString(), maxTimeout: Math.min(timeoutMs, 60_000) };
  if (verb === "POST") payload.postData = String(body || "");
  if (cookies.length) payload.cookies = cookies;
  const deadline = AbortSignal.timeout(timeoutMs);
  let response;
  try {
    response = await fetchImpl(service, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      redirect: "error", cache: "no-store", signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    });
  } catch (error) {
    if (signal?.aborted) throw failure("FLARESOLVERR_CANCELLED", "The FlareSolverr request was cancelled.", 499);
    throw failure("FLARESOLVERR_UNAVAILABLE", "Could not reach FlareSolverr.", 502);
  }
  if (!response.ok) throw failure("FLARESOLVERR_FAILED", `FlareSolverr returned HTTP ${response.status}.`);
  const contentLength = Number(response.headers.get("content-length"));
  if (contentLength > MAX_RESPONSE_BYTES) throw failure("FLARESOLVERR_RESPONSE_TOO_LARGE", "FlareSolverr returned too much data.", 413);
  const reader = response.body?.getReader();
  if (!reader) throw failure("FLARESOLVERR_INVALID_RESPONSE", "FlareSolverr returned no response.");
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > MAX_RESPONSE_BYTES) throw failure("FLARESOLVERR_RESPONSE_TOO_LARGE", "FlareSolverr returned too much data.", 413);
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {
    throw failure("FLARESOLVERR_INVALID_RESPONSE", "FlareSolverr returned invalid JSON.");
  }
  if (data?.status !== "ok" || !data.solution || typeof data.solution.response !== "string") {
    throw failure("FLARESOLVERR_FAILED", "FlareSolverr could not complete the indexer request.");
  }
  let resolved;
  try { resolved = new URL(data.solution.url); } catch {
    throw failure("FLARESOLVERR_INVALID_RESPONSE", "FlareSolverr returned an invalid destination.");
  }
  if (!["http:", "https:"].includes(resolved.protocol) || resolved.username || resolved.password || (url.protocol === "https:" && resolved.protocol !== "https:")) {
    throw failure("FLARESOLVERR_TARGET_BLOCKED", "FlareSolverr redirected to an unsafe destination.", 400);
  }
  await validateTarget(resolved.hostname);
  const buffer = Buffer.from(data.solution.response);
  if (buffer.length > maxBytes) throw failure("FLARESOLVERR_RESPONSE_TOO_LARGE", "The indexer response is too large.", 413);
  const solutionHeaders = Object.fromEntries(Object.entries(data.solution.headers || {}).map(([name, value]) => [name.toLowerCase(), value]));
  delete solutionHeaders["content-encoding"];
  delete solutionHeaders["content-length"];
  const cookiesOut = Array.isArray(data.solution.cookies) ? data.solution.cookies : [];
  const setCookies = cookiesOut.filter((item) => item && typeof item.name === "string" && typeof item.value === "string").map((item) => `${item.name}=${item.value}; Path=${item.path || "/"}${item.domain ? `; Domain=${item.domain}` : ""}${item.secure ? "; Secure" : ""}`);
  if (setCookies.length) solutionHeaders["set-cookie"] = setCookies;
  if (data.solution.userAgent) solutionHeaders["x-torplay-flaresolverr-user-agent"] = data.solution.userAgent;
  return { status: Number(data.solution.status) || 200, headers: solutionHeaders, body: buffer, url: resolved };
}
