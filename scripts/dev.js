import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { readLocalEnvironment } from "./local-environment.js";

const require = createRequire(import.meta.url);

export async function startDevelopment({
  spawnProcess = spawn,
  environment = { ...readLocalEnvironment(), ...process.env },
} = {}) {
  const nextBin = require.resolve("next/dist/bin/next");
  const isolateNextProcess = process.platform !== "win32";
  const nextProcess = spawnProcess(process.execPath, [nextBin, "dev"], {
    stdio: "inherit",
    detached: isolateNextProcess,
    env: environment,
  });
  let stopped = false;

  function stop(signal = "SIGTERM") {
    if (stopped) return;
    stopped = true;

    if (nextProcess.exitCode === null && !nextProcess.killed) {
      if (isolateNextProcess && nextProcess.pid) {
        try {
          process.kill(-nextProcess.pid, signal);
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      } else {
        nextProcess.kill(signal);
      }
    }
  }

  return { nextProcess, stop };
}

async function main() {
  let supervisor;
  let shuttingDown = false;

  try {
    supervisor = await startDevelopment();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  function shutdown(signal, exitCode) {
    if (shuttingDown) return;
    shuttingDown = true;

    try {
      supervisor.stop(signal);
    } catch (error) {
      console.error(error.message);
      exitCode = 1;
    }
    process.exit(exitCode);
  }

  process.on("SIGINT", () => shutdown("SIGINT", 130));
  process.on("SIGTERM", () => shutdown("SIGTERM", 143));
  process.on("SIGHUP", () => shutdown("SIGTERM", 129));
  supervisor.nextProcess.once("error", (error) => {
    console.error(`Next.js could not start: ${error.message}`);
    shutdown("SIGTERM", 1);
  });
  supervisor.nextProcess.once("exit", (code, signal) => {
    if (shuttingDown) return;
    const exitCode = Number.isInteger(code) ? code : signal ? 1 : 0;
    shutdown("SIGTERM", exitCode);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
