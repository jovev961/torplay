export function apiUrl(environmentKey, fallback, pathname = "", environment = process.env) {
  const base = environment[environmentKey]?.trim() || fallback;
  const url = new URL(pathname && !base.endsWith("/") ? base + "/" : base);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Invalid native provider endpoint.");
  }
  return pathname ? new URL(pathname, url) : url;
}

export async function requestJson(url, { signal, body } = {}) {
  const response = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal, cache: "no-store",
  });
  if (!response.ok) throw new Error("Native provider request failed.");
  return response.json();
}
