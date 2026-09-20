import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { configureJackett, readLocalEnvironment } from "./jackett-config.js";
import { MAC_DOCKER_PATH, resolveDockerCommand } from "./docker-paths.js";

export {
  resolveDockerCommand,
  resolveDockerDesktopCommand,
  windowsDockerDesktopPaths,
  windowsDockerPaths,
} from "./docker-paths.js";

const require = createRequire(import.meta.url);

export const COMPOSE_START_ARGS = [
  "compose",
  "up",
  "-d",
  "--wait",
  "--wait-timeout",
  "120",
  "jackett",
];
export const COMPOSE_STOP_ARGS = ["compose", "stop", "jackett"];

function dockerSpawnOptions(dockerCommand) {
  const options = { stdio: "inherit" };
  if (dockerCommand === MAC_DOCKER_PATH) {
    options.env = {
      ...process.env,
      PATH: `${path.dirname(MAC_DOCKER_PATH)}${path.delimiter}${process.env.PATH ?? ""}`,
    };
  }
  return options;
}

function waitForSuccess(child, label) {
  return new Promise((resolve, reject) => {
    child.once("error", (error) => {
      reject(new Error(`${label} could not start: ${error.message}`));
    });
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} failed${signal ? ` with ${signal}` : ` with exit code ${code}`}.`));
    });
  });
}

function requireSuccessfulResult(result, label) {
  if (result.error) throw new Error(`${label} could not start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status}.`);
}

export async function startDevelopment({
  spawnProcess = spawn,
  spawnSyncProcess = spawnSync,
  configureJackettProcess = configureJackett,
  dockerCommand = resolveDockerCommand(),
  environment = { ...readLocalEnvironment(), ...process.env },
} = {}) {
  const composeOptions = dockerSpawnOptions(dockerCommand);
  const managed = environment.TORPLAY_MANAGED_JACKETT === "true";
  if (managed) {
    try {
      const composeUp = spawnProcess(dockerCommand, COMPOSE_START_ARGS, composeOptions);
      await waitForSuccess(composeUp, "Development services");
      configureJackettProcess({
        dockerCommand,
        spawnSyncProcess,
        processEnvironment: composeOptions.env ?? process.env,
      });
    } catch (error) {
      spawnSyncProcess(dockerCommand, COMPOSE_STOP_ARGS, composeOptions);
      throw error;
    }
  }

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

    if (managed) {
      const result = spawnSyncProcess(dockerCommand, COMPOSE_STOP_ARGS, composeOptions);
      requireSuccessfulResult(result, "Development services shutdown");
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
