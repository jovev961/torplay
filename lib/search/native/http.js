export function nativeApiUrl(base, pathname = "") {
  const url = new URL(pathname && !base.endsWith("/") ? `${base}/` : base);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("Invalid native source endpoint.");
  }
  return pathname ? new URL(pathname, url) : url;
}

export async function requestNativeJson(url, { signal, body, fetchImpl = globalThis.fetch } = {}) {
  const response = await fetchImpl(url, {
    method: body ? "POST" : "GET",
    headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal,
    cache: "no-store",
    redirect: "error",
  });
  if (!response.ok) throw new Error("Native source request failed.");
  const data = await response.json().catch(() => null);
  if (!data || typeof data !== "object") throw new Error("Native source returned an invalid response.");
  return data;
}
