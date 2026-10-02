import { parentPort } from "node:worker_threads";

// Only data crosses this boundary; definitions never supply executable code.
parentPort.on("message", ({ input, pattern, flags, replacement }) => {
  try {
    const regex = new RegExp(pattern, flags);
    const result = replacement === undefined ? regex.exec(input) : input.replace(regex, replacement);
    if (typeof result === "string" && result.length > 5 * 1024 * 1024) throw new Error();
    if (Array.isArray(result) && result.reduce((size, value) => size + (value?.length || 0), 0) > 5 * 1024 * 1024) throw new Error();
    parentPort.postMessage({ result });
  } catch {
    parentPort.postMessage({ invalid: true });
  }
});
