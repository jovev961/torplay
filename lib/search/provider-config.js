export function providerIds(value) {
  return [...new Set(String(value || "").split(",").map((id) => id.trim()).filter(Boolean))];
}

export function jackettIsConfigured(environment = process.env) {
  const apiKey = String(environment.JACKETT_API_KEY || "").trim();
  return Boolean(apiKey && apiKey !== "replace-me");
}
