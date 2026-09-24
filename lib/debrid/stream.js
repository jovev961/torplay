import { lookup } from "node:dns/promises";
import https from "node:https";
import ipaddr from "ipaddr.js";
import { Readable } from "node:stream";
import { parseByteRange } from "../video/range.js";
import { DebridError } from "./http.js";

const REFRESHABLE_REMOTE_STATUSES = new Set([401, 403, 410, 451]);

export function isRefreshableRemoteFailure(error) {
  return REFRESHABLE_REMOTE_STATUSES.has(Number(error?.upstreamStatus))
    || ["unavailable", "timeout"].includes(error?.code);
}

function rejectedRange(status) {
  const error = new DebridError("remote-stream-unavailable",
    status === 451
      ? "The provider rejected the media link with HTTP 451. Check the provider account or VPN and try again."
      : `The provider stream does not support valid byte ranges${status ? ` (HTTP ${status})` : ""}.`);
  error.upstreamStatus = status || null;
  return error;
}

function safeUrl(raw) {
  let url;
  try { url = new URL(raw); } catch {
    throw new DebridError("unsafe-url", "The provider returned an invalid media URL.");
  }
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname) {
    throw new DebridError("unsafe-url", "The provider returned an unsafe media URL.");
  }
  return url;
}

async function publicAddresses(hostname, resolveImpl) {
  const addresses = ipaddr.isValid(hostname)
    ? [{ address: hostname, family: ipaddr.parse(hostname).kind() === "ipv4" ? 4 : 6 }]
    : await resolveImpl(hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => {
    try { return ipaddr.parse(address).range() !== "unicast"; } catch { return true; }
  })) throw new DebridError("unsafe-url", "The provider media host is unsafe.");
  return addresses;
}

export async function openRemoteUrl(raw, {
  method = "GET", range = null, signal = null, resolveImpl = lookup,
  requestImpl = https.request, redirects = 0, allowRedirects = true, headers = {},
} = {}) {
  if (redirects > 5) throw new DebridError("redirect-limit", "The provider redirected too many times.");
  const url = safeUrl(raw);
  let addresses;
  try { addresses = await publicAddresses(url.hostname, resolveImpl); }
  catch (error) {
    if (error instanceof DebridError) throw error;
    throw new DebridError("unavailable", "The provider media host could not be resolved.");
  }
  const response = await new Promise((resolve, reject) => {
    const request = requestImpl(url, {
      method, headers: range ? { ...headers, Range: range } : headers,
      lookup: (_hostname, options, callback) => options?.all
        ? callback(null, addresses)
        : callback(null, addresses[0].address, addresses[0].family),
      signal, timeout: 12_000,
    }, resolve);
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", () => reject(new DebridError("unavailable", "The remote media request failed.")));
    request.end();
  });
  if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
    if (!allowRedirects) {
      response.destroy();
      throw new DebridError("unsafe-url", "The indexer redirected the NZB request.");
    }
    const location = response.headers.location;
    response.destroy();
    if (!location) throw new DebridError("malformed-response", "The provider redirect is invalid.");
    return openRemoteUrl(new URL(location, url).href, {
      method, range, signal, resolveImpl, requestImpl, redirects: redirects + 1,
      allowRedirects, headers,
    });
  }
  return response;
}

export async function probeRemoteUrl(url, options = {}) {
  const response = await openRemoteUrl(url, { ...options, range: "bytes=0-0" });
  const valid = response.statusCode === 206
    && /^bytes 0-0\/\d+$/i.test(String(response.headers["content-range"] || ""));
  const status = response.statusCode;
  response.destroy();
  if (!valid) throw rejectedRange(status);
}

export async function proxyRemoteFile(request, file, resolveUrl, options = {}) {
  const range = parseByteRange(request.headers.get("range"), file.length);
  if (range.error) return new Response(null, {
    status: 416, headers: { "Content-Range": `bytes */${file.length}` },
  });
  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    "Content-Type": file.mimeType,
    "Content-Length": String(range.end - range.start + 1),
  });
  if (range.partial) headers.set("Content-Range", `bytes ${range.start}-${range.end}/${file.length}`);
  const status = range.partial ? 206 : 200;
  if (request.method === "HEAD") return new Response(null, { status, headers });
  const upstreamRange = `bytes=${range.start}-${range.end}`;
  let response;
  let previousUrl = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const url = await resolveUrl(attempt > 0, previousUrl);
    try {
      response = await openRemoteUrl(url, {
        range: upstreamRange, signal: request.signal, ...options,
      });
    } catch (error) {
      if (attempt === 0 && !request.signal.aborted && isRefreshableRemoteFailure(error)) {
        previousUrl = url;
        console.info("Debrid media connection failed; refreshing URL", { code: error.code });
        continue;
      }
      throw error;
    }
    if (!REFRESHABLE_REMOTE_STATUSES.has(response.statusCode) || attempt > 0) break;
    console.info("Debrid media range URL rejected; refreshing URL", { status: response.statusCode });
    previousUrl = url;
    response.destroy();
  }
  if (response.statusCode !== 206
    || String(response.headers["content-range"] || "") !==
      `bytes ${range.start}-${range.end}/${file.length}`) {
    response.destroy();
    console.info("Debrid media range rejected", { status: response.statusCode });
    throw rejectedRange(response.statusCode);
  }
  request.signal.addEventListener("abort", () => response.destroy(), { once: true });
  if (typeof options.onClose === "function") response.once("close", options.onClose);
  return new Response(Readable.toWeb(response), { status, headers });
}
