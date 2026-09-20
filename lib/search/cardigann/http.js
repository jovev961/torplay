import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import ipaddr from "ipaddr.js";

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function publicAddress(value) {
  try {
    const address = ipaddr.process(value);
    return address.range() === "unicast";
  } catch {
    return false;
  }
}

export async function resolvePublicAddress(hostname, lookupImpl = dns.lookup) {
  const addresses = await new Promise((resolve, reject) => {
    lookupImpl(hostname, { all: true, verbatim: true }, (error, records) => {
      if (error) reject(error);
      else resolve(records);
    });
  });
  const publicRecords = addresses.filter((record) => publicAddress(record.address));
  if (!publicRecords.length || publicRecords.length !== addresses.length) {
    throw Object.assign(new Error("The URL must resolve only to public internet addresses."), { status: 400 });
  }
  return publicRecords[0];
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
      lookup(_hostname, _options, callback) {
        callback(null, resolved.address, resolved.family);
      },
    }, (response) => {
      const chunks = [];
      let length = 0;
      response.on("data", (chunk) => {
        length += chunk.length;
        if (length > maxBytes) {
          request.destroy(Object.assign(new Error("The remote response is too large."), { status: 413 }));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        try {
          const decoded = decodedBody(Buffer.concat(chunks), response.headers["content-encoding"], maxBytes);
          if (decoded.length > maxBytes) throw Object.assign(new Error("The remote response is too large."), { status: 413 });
          resolve({ status: response.statusCode || 0, headers: response.headers, body: decoded, url });
        } catch (error) {
          reject(error);
        }
      });
      response.on("error", reject);
    });
    request.on("timeout", () => request.destroy(Object.assign(new Error("The remote request timed out."), { status: 504 })));
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

export async function safeRequest(rawUrl, options = {}) {
  let url;
  try { url = new URL(rawUrl); } catch { throw Object.assign(new Error("Enter a valid URL."), { status: 400 }); }
  const protocols = options.protocols || ["https:"];
  if (!protocols.includes(url.protocol) || url.username || url.password) {
    throw Object.assign(new Error(`The URL must use ${protocols.join(" or ")} without embedded credentials.`), { status: 400 });
  }

  const requestImpl = options.requestImpl || requestOnce;
  let method = options.method || "GET";
  let body = options.body;
  for (let redirects = 0; redirects <= (options.maxRedirects ?? 5); redirects += 1) {
    const response = await requestImpl(url, {
      ...options,
      method,
      body,
      timeoutMs: options.timeoutMs ?? 15_000,
      maxBytes: options.maxBytes ?? 5 * 1024 * 1024,
    });
    await options.onResponse?.(response);
    if (!REDIRECTS.has(response.status)) return response;
    if (redirects === (options.maxRedirects ?? 5)) {
      throw Object.assign(new Error("The remote server redirected too many times."), { status: 422 });
    }
    const location = Array.isArray(response.headers.location) ? response.headers.location[0] : response.headers.location;
    if (!location) throw Object.assign(new Error("The remote server returned an invalid redirect."), { status: 422 });
    const redirected = new URL(location, url);
    if (!protocols.includes(redirected.protocol) || redirected.username || redirected.password
      || (url.protocol === "https:" && redirected.protocol !== "https:")) {
      throw Object.assign(new Error("The remote server redirected to an unsupported URL."), { status: 422 });
    }
    url = redirected;
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
      method = "GET";
      body = undefined;
    }
  }
  throw new Error("Unreachable redirect state.");
}
