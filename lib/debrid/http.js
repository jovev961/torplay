export class DebridError extends Error {
  constructor(code, message, status = 502, retryAfter = null) {
    super(message);
    this.name = "DebridError";
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export async function providerRequest(base, endpoint, {
  method = "GET", token = null, body = null, fetchImpl = globalThis.fetch,
  timeoutMs = 8_000, headers = {}, raw = false,
} = {}) {
  const url = new URL(endpoint, base);
  const requestHeaders = new Headers(headers);
  if (token) requestHeaders.set("Authorization", `Bearer ${token}`);
  let response;
  try {
    response = await fetchImpl(url, {
      method, headers: requestHeaders, body, cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs), redirect: "error",
    });
  } catch (error) {
    throw new DebridError(
      error?.name === "TimeoutError" ? "timeout" : "unavailable",
      error?.name === "TimeoutError" ? "The debrid provider timed out." : "The debrid provider is unavailable.",
    );
  }
  if (!response.ok) {
    const code = response.status === 401 || response.status === 403 ? "authentication"
      : response.status === 429 ? "rate-limited"
        : response.status >= 500 ? "unavailable" : "provider-error";
    const error = new DebridError(code, `The debrid provider returned HTTP ${response.status}.`,
      response.status === 429 ? 429 : 502, response.headers.get("retry-after"));
    error.upstreamStatus = response.status;
    throw error;
  }
  if (raw || response.status === 204 || response.status === 202) return response;
  try {
    return await response.json();
  } catch {
    throw new DebridError("malformed-response", "The debrid provider returned invalid data.");
  }
}

export function requireData(value, predicate) {
  if (!predicate(value)) throw new DebridError("malformed-response", "The debrid provider returned invalid data.");
  return value;
}
