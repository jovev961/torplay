import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { gunzipSync, inflateSync, brotliDecompressSync } from "node:zlib";
import ipaddr from "ipaddr.js";
import { isPublicInternetAddress } from "./private-address.js";

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const SAFE_HEADERS = new Set(["accept", "accept-encoding", "user-agent", "content-type"]);

export class NetworkError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.name = "NetworkError";
    this.code = code;
    this.status = status;
  }
}

export function networkDiagnostic(error) {
  if (error instanceof NetworkError) return error;
  if (["ENOTFOUND", "EAI_AGAIN", "ENODATA"].includes(error?.code)) {
    return new NetworkError("REMOTE_DNS_FAILED", "The destination could not be resolved.");
  }
  if (error?.name === "TimeoutError" || ["ETIMEDOUT", "ESOCKETTIMEDOUT"].includes(error?.code)) {
    return new NetworkError("REMOTE_REQUEST_TIMEOUT", "The remote request timed out.", 504);
  }
  if (error?.name === "AbortError" || error?.code === "ABORT_ERR") {
    return new NetworkError("REMOTE_REQUEST_CANCELLED", "The remote request was cancelled.", 499);
  }
  return new NetworkError("REMOTE_CONNECTION_FAILED", "Connection to the remote server failed.");
}

// A deadline bounds the whole operation, including DNS, redirects and body reads.
export async function withDeadline(operation, { signal, timeoutMs = 15_000 } = {}) {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException("Operation timed out.", "TimeoutError")), timeoutMs);
  let onAbort;
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return operation(controller.signal);
      }),
      new Promise((_, reject) => {
        onAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener("abort", onAbort, { once: true });
        if (controller.signal.aborted) onAbort();
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", onAbort);
  }
}

export function endpointUrl(value, { protocols = ["https:"], base = false } = {}) {
  let url;
  try { url = new URL(String(value)); }
  catch { throw new NetworkError("REMOTE_URL_INVALID", "Enter a valid endpoint URL.", 400); }
  if (!protocols.includes(url.protocol) || url.username || url.password || url.hash
    || (base && url.search)) {
    throw new NetworkError("REMOTE_URL_UNSUPPORTED", "The endpoint URL has an unsupported protocol, credentials, or suffix.", 400);
  }
  return url;
}

function addressKind(value) {
  try {
    if (isPublicInternetAddress(value)) return "public";
    const range = ipaddr.process(value).range();
    if (["private", "loopback", "uniqueLocal"].includes(range)) return "private";
  } catch { /* Invalid addresses are blocked. */ }
  return "blocked";
}

export async function destination(hostname, { policy = "external", lookup = dns.lookup, signal } = {}) {
  signal?.throwIfAborted();
  const host = hostname.replace(/^\[|\]$/g, "");
  const records = await new Promise((resolve, reject) => {
    lookup(host, { all: true, verbatim: true }, (error, addresses) => error ? reject(networkDiagnostic(error)) : resolve(addresses));
  });
  signal?.throwIfAborted();
  const kinds = new Set((records || []).map((item) => addressKind(item.address)));
  if (!records?.length || kinds.size !== 1 || kinds.has("blocked")
    || (policy === "external" && !kinds.has("public"))
    || (policy === "local-service" && !kinds.has("private"))) {
    throw new NetworkError("REMOTE_DESTINATION_BLOCKED", "The destination is not permitted by the network policy.", 400);
  }
  if (!["external", "configured-service", "local-service"].includes(policy)) {
    throw new NetworkError("REMOTE_DESTINATION_BLOCKED", "The destination policy is invalid.", 400);
  }
  return records[0];
}

async function exchange(url, options) {
  const address = await destination(url.hostname, options);
  options.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? https : http).request(url, {
      method: options.method,
      headers: options.headers,
      signal: options.signal,
      lookup: (_hostname, lookupOptions, callback) => lookupOptions?.all
        ? callback(null, [address]) : callback(null, address.address, address.family),
    }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > options.maxBytes) {
          request.destroy(new NetworkError("REMOTE_RESPONSE_TOO_LARGE", "The remote response is too large.", 413));
        } else chunks.push(chunk);
      });
      response.on("aborted", () => reject(new NetworkError("REMOTE_INVALID_RESPONSE", "The remote response was interrupted.")));
      response.on("error", reject);
      response.on("end", () => {
        try {
          const raw = Buffer.concat(chunks);
          const decode = { gzip: gunzipSync, deflate: inflateSync, br: brotliDecompressSync }[response.headers["content-encoding"]];
          const body = decode ? decode(raw, { maxOutputLength: options.maxBytes }) : raw;
          if (body.length > options.maxBytes) throw new NetworkError("REMOTE_RESPONSE_TOO_LARGE", "The remote response is too large.", 413);
          resolve({ status: response.statusCode, headers: response.headers, body, url });
        } catch { reject(new NetworkError("REMOTE_INVALID_RESPONSE", "The remote response could not be decoded.")); }
      });
    });
    request.on("error", reject);
    request.end(options.body);
  });
}

export async function request(rawUrl, options = {}) {
  try {
    return await withDeadline(async (signal) => {
      let url = endpointUrl(rawUrl, options);
      let method = options.method || "GET";
      let body = options.body;
      let headers = { "Accept-Encoding": "gzip, deflate, br", ...options.headers };
      const firstOrigin = url.origin;
      for (let redirects = 0; redirects <= (options.maxRedirects ?? 5); redirects++) {
        signal.throwIfAborted();
        if (options.headersFor) headers = { ...headers, ...await options.headersFor(url) };
        const response = await exchange(url, { ...options, signal, method, body, headers,
          maxBytes: options.maxBytes ?? 5 * 1024 * 1024 });
        await options.onResponse?.(response);
        if (!REDIRECTS.has(response.status)) return response;
        if (redirects === (options.maxRedirects ?? 5) || !response.headers.location) {
          throw new NetworkError("REMOTE_REDIRECT_INVALID", "The remote redirect could not be followed.", 422);
        }
        const next = endpointUrl(new URL(response.headers.location, url), options);
        if ((url.protocol === "https:" && next.protocol !== "https:")
          || (options.sameOrigin && next.origin !== firstOrigin)) {
          throw new NetworkError("REMOTE_REDIRECT_BLOCKED", "The remote redirect is not permitted.", 400);
        }
        if (url.origin !== next.origin) {
          headers = Object.fromEntries(Object.entries(headers).filter(([name]) => SAFE_HEADERS.has(name.toLowerCase())));
          if (body && ![301, 302, 303].includes(response.status)) {
            throw new NetworkError("REMOTE_REDIRECT_BLOCKED", "A credential-bearing request cannot redirect to another origin.", 400);
          }
        }
        if (response.status === 303 || ([301, 302].includes(response.status) && method === "POST")) {
          method = "GET";
          body = undefined;
        }
        url = next;
      }
      throw new NetworkError("REMOTE_REDIRECT_INVALID", "The remote redirect could not be followed.");
    }, options);
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason;
    throw networkDiagnostic(error);
  }
}

export async function validateFlareSolverrEndpoint(value, lookup) {
  const url = endpointUrl(value, { protocols: ["http:", "https:"], base: true });
  if (!["/", "/v1"].includes(url.pathname)) throw new NetworkError("FLARESOLVERR_URL_INVALID", "Use a FlareSolverr base URL or /v1 endpoint.", 400);
  await withDeadline((signal) => destination(url.hostname, { policy: "local-service", lookup, signal }));
  url.pathname = "/v1";
  return url;
}
