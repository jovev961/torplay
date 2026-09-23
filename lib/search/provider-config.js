export function providerIds(value) {
  return [...new Set(String(value || "").split(",").map((id) => id.trim()).filter(Boolean))];
}
