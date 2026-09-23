export async function copyText(value, {
  navigatorRef = globalThis.navigator,
  documentRef = globalThis.document,
} = {}) {
  const text = String(value || "");
  if (!text) throw new Error("There is no address to copy.");

  if (navigatorRef?.clipboard?.writeText) {
    try {
      await navigatorRef.clipboard.writeText(text);
      return "clipboard";
    } catch {
      // HTTP LAN pages may not have access to the secure-context Clipboard API.
    }
  }

  if (!documentRef?.body?.appendChild || typeof documentRef.execCommand !== "function") {
    throw new Error("Copy is unavailable in this browser.");
  }
  const input = documentRef.createElement("textarea");
  input.value = text;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.opacity = "0";
  documentRef.body.appendChild(input);
  let copied = false;
  try {
    input.select();
    copied = documentRef.execCommand("copy");
  } finally {
    input.remove();
  }
  if (!copied) throw new Error("The address could not be copied.");
  return "fallback";
}
