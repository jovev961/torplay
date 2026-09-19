import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
export function startNativeDevelopment({ spawnProcess = spawn, environment = process.env } = {}) {
  return spawnProcess(process.execPath, [require.resolve("next/dist/bin/next"), "dev"], {
    stdio: "inherit",
    env: { ...environment, TORPLAY_SEARCH_PROVIDERS: "knaben,yts,eztv" },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const child = startNativeDevelopment();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => { if (!child.killed) child.kill(signal); });
  }
  child.once("error", () => { console.error("Native development server could not start."); process.exitCode = 1; });
  child.once("exit", (code) => { process.exitCode = code ?? 1; });
}
