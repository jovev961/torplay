export async function sourceRequest(action, provider, refresh = false, extra = {}) {
  const response = await fetch("/api/settings/torrent-providers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, provider, refresh, ...extra }),
  });
  const body = await response.json();
  if (!response.ok) {
    const details = body.unsupportedFeatures?.map((item) => `${item.message} (${item.path})`).join(" ");
    throw Object.assign(new Error([body.error || "Provider request failed.", details].filter(Boolean).join(" ")), body);
  }
  return body;
}
