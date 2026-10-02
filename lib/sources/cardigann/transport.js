import { CookieJar } from "tough-cookie";
import { request, destination, endpointUrl, withDeadline, validateFlareSolverrEndpoint, NetworkError } from "../../network/request.js";
import { SourceError } from "../contract.js";
import { requiresFlareSolverr } from "./definition.js";
import { setTimeout as delay } from "node:timers/promises";

const pacingKey = Symbol.for("torplay.sources.cardigannPacing");

function paced(key, milliseconds, signal, operation) {
  if (!(milliseconds > 0)) return operation();
  const records = globalThis[pacingKey] ??= new Map();
  const now = Date.now();
  for (const [id, state] of records) if (!state.pending && state.nextAt <= now) records.delete(id);
  const state = records.get(key) || { tail: Promise.resolve(), nextAt: 0, pending: 0 };
  records.set(key, state);
  state.pending++;
  const run = state.tail.then(async () => {
    signal?.throwIfAborted();
    const wait = state.nextAt - Date.now();
    if (wait > 0) await delay(wait, undefined, { signal });
    signal?.throwIfAborted();
    state.nextAt = Date.now() + milliseconds;
    return operation();
  });
  state.tail = run.then(() => {}, () => {}).finally(() => { state.pending--; });
  return run;
}

async function solver(url, options, endpoint) {
  return withDeadline(async (signal) => {
    const target = endpointUrl(url, { protocols: ["http:", "https:"] });
    await destination(target.hostname, { signal });
    const service = await validateFlareSolverrEndpoint(endpoint);
    const method = options.method || "GET";
    if (!["GET", "POST"].includes(method) || (method === "POST" && !/application\/x-www-form-urlencoded/i.test(options.headers["Content-Type"] || ""))) {
      throw new SourceError("CARDIGANN_UNSUPPORTED", "This request cannot use FlareSolverr.");
    }
    if (Object.keys(options.headers).some((name) => !["accept", "cookie", "user-agent", "content-type"].includes(name.toLowerCase()))) {
      throw new SourceError("CARDIGANN_UNSUPPORTED", "FlareSolverr cannot send the required request headers.");
    }
    const cookies = String(options.headers.Cookie || "").split(";").flatMap((pair) => {
      const index = pair.indexOf("=");
      return index > 0 ? [{ name: pair.slice(0, index).trim(), value: pair.slice(index + 1).trim() }] : [];
    });
    const response = await request(service, { signal, policy: "local-service", protocols: ["http:", "https:"],
      sameOrigin: true, maxRedirects: 0, timeoutMs: 65_000, maxBytes: 6 * 1024 * 1024,
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        cmd: method === "POST" ? "request.post" : "request.get", url: target.href, maxTimeout: 60_000,
        ...(method === "POST" ? { postData: String(options.body || "") } : {}), ...(cookies.length ? { cookies } : {}),
      }) });
    if (response.status !== 200) throw new SourceError("SOURCE_UNAVAILABLE", "FlareSolverr could not complete the request.", 502);
    let data;
    try { data = JSON.parse(response.body.toString("utf8")); } catch { throw new SourceError("INVALID_RESPONSE", "FlareSolverr returned invalid JSON."); }
    if (data?.status !== "ok" || typeof data.solution?.response !== "string") throw new SourceError("SOURCE_UNAVAILABLE", "FlareSolverr could not complete the request.", 502);
    const resolved = endpointUrl(data.solution.url, { protocols: ["http:", "https:"] });
    if (target.protocol === "https:" && resolved.protocol !== "https:") throw new SourceError("REMOTE_REDIRECT_BLOCKED", "The service reported an unsafe redirect.", 400);
    if (options.sameOrigin && resolved.origin !== target.origin) throw new SourceError("REMOTE_REDIRECT_BLOCKED", "The service reported a redirect outside the source.", 400);
    await destination(resolved.hostname, { signal });
    const body = Buffer.from(data.solution.response);
    if (body.length > 5 * 1024 * 1024) throw new SourceError("INVALID_RESPONSE", "The source response is too large.");
    const headers = Object.fromEntries(Object.entries(data.solution.headers || {}).map(([name, value]) => [name.toLowerCase(), value]));
    delete headers["content-encoding"];
    delete headers["content-length"];
    // The solver owns its internal redirects; accept only validated final destinations.
    return { status: Number(data.solution.status), headers, body, url: resolved,
      cookies: data.solution.cookies, userAgent: data.solution.userAgent };
  }, { signal: options.signal, timeoutMs: 65_000 });
}

export function cardigannSession(definition, base, environment, options = {}) {
  const jar = new CookieJar();
  const needsSolver = requiresFlareSolverr(definition);
  const origin = new URL(base).origin;
  let userAgent = "TorPlay";
  function checkCredentials(target, credentials) {
    if (!credentials) return;
    if (target.protocol !== "https:") throw new NetworkError("REMOTE_URL_UNSUPPORTED", "Source credentials require HTTPS.", 400);
    if (target.origin !== origin) throw new NetworkError("REMOTE_REDIRECT_BLOCKED", "Source credentials cannot be sent to another origin.", 400);
  }
  return {
    jar,
    request(url, values = {}) {
      return paced(options.sourceKey || base, Number(definition.requestDelay || 0) * 1000, values.signal, async () => {
      const target = endpointUrl(url, { protocols: ["http:", "https:"] });
      values.signal?.throwIfAborted();
      const cookies = await jar.getCookieString(target.href);
      const configuredCookie = Object.entries(values.headers || {}).find(([name]) => name.toLowerCase() === "cookie")?.[1] || "";
      const sensitive = cookies || Object.keys(values.headers || {}).some((name) => /authorization|cookie|token|key/i.test(name));
      checkCredentials(target, sensitive || values.credentials);
      const headers = { Accept: "text/html, application/json, */*", "User-Agent": userAgent,
        ...Object.fromEntries(Object.entries(values.headers || {}).filter(([name]) => name.toLowerCase() !== "cookie")),
        ...(cookies || configuredCookie ? { Cookie: cookies || configuredCookie } : {}) };
      if (needsSolver && !environment.FLARESOLVERR_URL) throw new SourceError("FLARESOLVERR_NOT_CONFIGURED", "Requires FlareSolverr.");
      const response = await (options.request ? options.request(target, { ...values, headers })
        : needsSolver && !values.metadata ? solver(target, { ...values, headers, sameOrigin: Boolean(sensitive || values.credentials) }, environment.FLARESOLVERR_URL)
          : request(target, { ...values, headers, protocols: ["http:", "https:"],
            sameOrigin: Boolean(sensitive || values.credentials), maxBytes: 5 * 1024 * 1024,
            headersFor: async (next) => {
              const cookies = await jar.getCookieString(next.href);
              checkCredentials(next, cookies || configuredCookie);
              return { Cookie: cookies || configuredCookie };
            },
            onResponse: async (page) => {
              const set = page.headers["set-cookie"];
              for (const cookie of set ? Array.isArray(set) ? set : [set] : []) await jar.setCookie(cookie, page.url.href, { ignoreError: true });
            } }));
      if (response.userAgent) userAgent = String(response.userAgent).slice(0, 300);
      for (const cookie of Array.isArray(response.cookies) ? response.cookies : []) {
        if (typeof cookie?.name !== "string" || typeof cookie.value !== "string") continue;
        const value = `${cookie.name}=${cookie.value}; Path=${cookie.path || "/"}${cookie.domain ? `; Domain=${cookie.domain}` : ""}${cookie.secure ? "; Secure" : ""}`;
        await jar.setCookie(value, response.url.href, { ignoreError: true });
      }
      if ([401, 403].includes(response.status)) throw new SourceError("AUTHENTICATION_FAILED", "Source authentication failed.", 401);
      if (response.status < 200 || response.status >= 400) throw new SourceError("SOURCE_UNAVAILABLE", "The source rejected the request.", 502);
      return response;
      });
    },
  };
}
