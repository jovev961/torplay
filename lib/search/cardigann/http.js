import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import ipaddr from "ipaddr.js";

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const safeDiagnostic = Symbol("safeRemoteDiagnostic");

function remoteError(message, status, code) {
  return Object.assign(new Error(message), { status, code, [safeDiagnostic]: true });
}

export function classifyRequestFailure(error) {
  if (error?.[safeDiagnostic]) return error;
  if (["ENOTFOUND", "EAI_AGAIN", "EAI_FAIL", "ENODATA"].includes(error?.code)) {
    return remoteError("The destination hostname could not be resolved.", 502, "REMOTE_DNS_FAILED");
  }
  if (error?.name === "AbortError" || error?.code === "ABORT_ERR") {
    return remoteError("The remote request was cancelled.", 499, "REMOTE_REQUEST_CANCELLED");
  }
  if (["ETIMEDOUT", "ESOCKETTIMEDOUT"].includes(error?.code)) {
    return remoteError("The remote request timed out.", 504, "REMOTE_REQUEST_TIMEOUT");
  }
  return remoteError("Connection to the remote server failed.", 502, "REMOTE_CONNECTION_FAILED");
}

function publicAddress(value) {
  try {
    const address = ipaddr.process(value);
    return address.range() === "unicast";
  } catch {
    return false;
  }
}

export async function resolvePublicAddress(hostname, lookupImpl = dns.lookup) {
  let addresses;
  try {
    addresses = await new Promise((resolve, reject) => {
      lookupImpl(hostname, { all: true, verbatim: true }, (error, records) => {
        if (error) reject(error);
        else resolve(records);
      });
    });
  } catch (error) {
    throw classifyRequestFailure(error);
  }
  if (!Array.isArray(addresses) || !addresses.length) {
    throw remoteError("The destination hostname could not be resolved.", 502, "REMOTE_DNS_FAILED");
  }
  const publicRecords = addresses.filter((record) => publicAddress(record.address));
  if (!publicRecords.length || publicRecords.length !== addresses.length) {
    throw remoteError("The destination is blocked because it does not resolve only to public internet addresses.", 400, "REMOTE_DESTINATION_BLOCKED");
  }
  return publicRecords[0];
}

export function pinnedLookup(record) {
  return (_hostname, options, callback) => {
    if (options?.all) callback(null, [{ address: record.address, family: record.family }]);
    else callback(null, record.address, record.family);
  };
}

function decodedBody(buffer, encoding, maxBytes) {
  const options = { maxOutputLength: maxBytes };
  if (encoding === "gzip") return gunzipSync(buffer, options);
  if (encoding === "deflate") return inflateSync(buffer, options);
  if (encoding === "br") return brotliDecompressSync(buffer, options);
  return buffer;
}

async function requestOnce(url, {
  method = "GET",
  headers = {},
  body,
  signal,
  timeoutMs,
  maxBytes,
  lookupImpl,
} = {}) {
  const resolved = await resolvePublicAddress(url.hostname, lookupImpl);
  const transport = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request(url, {
      method,
      headers: { "Accept-Encoding": "gzip, deflate, br", ...headers },
      signal,
      timeout: timeoutMs,
      lookup: pinnedLookup(resolved),
    }, (response) => {
      const chunks = [];
      let length = 0;
      response.on("data", (chunk) => {
        length += chunk.length;
        if (length > maxBytes) {
          request.destroy(remoteError("The remote response is too large.", 413, "REMOTE_RESPONSE_TOO_LARGE"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        try {
          const decoded = decodedBody(Buffer.concat(chunks), response.headers["content-encoding"], maxBytes);
          if (decoded.length > maxBytes) throw remoteError("The remote response is too large.", 413, "REMOTE_RESPONSE_TOO_LARGE");
          resolve({ status: response.statusCode || 0, headers: response.headers, body: decoded, url });
        } catch (error) {
          reject(error);
        }
      });
      response.on("error", reject);
    });
    request.on("timeout", () => request.destroy(remoteError("The remote request timed out.", 504, "REMOTE_REQUEST_TIMEOUT")));
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

export async function safeRequest(rawUrl, options = {}) {
  let url;
  try { url = new URL(rawUrl); } catch { throw remoteError("Enter a valid URL.", 400, "REMOTE_URL_INVALID"); }
  const protocols = options.protocols || ["https:"];
  if (!protocols.includes(url.protocol) || url.username || url.password) {
    throw remoteError(`The URL must use ${protocols.join(" or ")} without embedded credentials.`, 400, "REMOTE_URL_UNSUPPORTED");
  }

  const requestImpl = options.requestImpl || requestOnce;
  let method = options.method || "GET";
  let body = options.body;
  for (let redirects = 0; redirects <= (options.maxRedirects ?? 5); redirects += 1) {
    let response;
    try {
      response = await requestImpl(url, {
        ...options,
        method,
        body,
        timeoutMs: options.timeoutMs ?? 15_000,
        maxBytes: options.maxBytes ?? 5 * 1024 * 1024,
      });
    } catch (error) {
      throw classifyRequestFailure(error);
    }
    await options.onResponse?.(response);
    if (!REDIRECTS.has(response.status)) return response;
    if (redirects === (options.maxRedirects ?? 5)) {
      throw remoteError("The remote server redirected too many times.", 422, "REMOTE_REDIRECT_LIMIT");
    }
    const location = Array.isArray(response.headers.location) ? response.headers.location[0] : response.headers.location;
    if (!location) throw remoteError("The remote server returned an invalid redirect.", 422, "REMOTE_REDIRECT_INVALID");
    let redirected;
    try { redirected = new URL(location, url); }
    catch { throw remoteError("The remote server returned an invalid redirect.", 422, "REMOTE_REDIRECT_INVALID"); }
    if (!protocols.includes(redirected.protocol) || redirected.username || redirected.password
      || (url.protocol === "https:" && redirected.protocol !== "https:")) {
      throw remoteError("The remote server redirected to a blocked or unsupported URL.", 422, "REMOTE_REDIRECT_BLOCKED");
    }
    url = redirected;
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
      method = "GET";
      body = undefined;
    }
  }
  throw new Error("Unreachable redirect state.");
}
