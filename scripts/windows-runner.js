import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installedEnvironment, installedPaths } from "./windows-paths.js";
import { stopInstalledRuntime } from "./windows-control.js";

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_BACKUPS = 3;

export function rotateLogs(logPath, { maxBytes = DEFAULT_MAX_BYTES, backups = DEFAULT_BACKUPS } = {}) {
  if (!existsSync(logPath) || statSync(logPath).size < maxBytes) return false;
  const oldest = `${logPath}.${backups}`;
  if (existsSync(oldest)) unlinkSync(oldest);
  for (let index = backups - 1; index >= 1; index -= 1) {
    const source = `${logPath}.${index}`;
    if (existsSync(source)) renameSync(source, `${logPath}.${index + 1}`);
  }
  renameSync(logPath, `${logPath}.1`);
  return true;
}

export function createRotatingLog(logPath, options = {}) {
  mkdirSync(path.dirname(logPath), { recursive: true });
  const maxBytes = options.maxBytes || DEFAULT_MAX_BYTES;
  return {
    write(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      if (existsSync(logPath) && statSync(logPath).size + buffer.length > maxBytes) {
        rotateLogs(logPath, { ...options, maxBytes });
      }
      appendFileSync(logPath, buffer);
    },
  };
}

export function attachInstalledRuntimeLifecycle(child, {
  paths = installedPaths(),
  environment = process.env,
  processRef = process,
  stopRuntime = stopInstalledRuntime,
} = {}) {
  let stopping = false;
  const listeners = new Map();
  const detach = () => {
    for (const [signal, listener] of listeners) processRef.removeListener(signal, listener);
    listeners.clear();
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    const listener = () => {
      if (stopping) return;
      stopping = true;
      void stopRuntime({ paths, environment })
        .then((result) => {
          if (result?.stopped === false && child.exitCode === null) child.kill?.();
        })
        .catch(() => {
          child.kill?.();
          processRef.exitCode = 1;
        });
    };
    listeners.set(signal, listener);
    processRef.once(signal, listener);
  }
  child.once("exit", detach);
  return detach;
}

export function runInstalledRuntime({
  paths = installedPaths(),
  environment = process.env,
  spawnProcess = spawn,
  processRef = process,
  createInstanceId = randomUUID,
} = {}) {
  const runtimeEnvironment = {
    ...installedEnvironment(paths, environment),
    TORPLAY_RUNNER_PID: String(processRef.pid),
    TORPLAY_RUNTIME_INSTANCE_ID: createInstanceId(),
  };
  const output = createRotatingLog(paths.logPath);
  output.write(`\n[${new Date().toISOString()}] TorPlay launcher starting.\n`);
  const child = spawnProcess(paths.nodePath, [paths.homeEntry], {
    cwd: paths.installDir,
    env: runtimeEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout?.on("data", (chunk) => output.write(chunk));
  child.stderr?.on("data", (chunk) => output.write(chunk));
  attachInstalledRuntimeLifecycle(child, { paths, environment: runtimeEnvironment, processRef });
  let finished = false;
  const finish = (code, signal = null) => {
    if (finished) return;
    finished = true;
    output.write(
      `[${new Date().toISOString()}] TorPlay exited${signal ? ` with ${signal}` : ` with code ${code}`}.\n`,
    );
    processRef.exit(code || (signal ? 1 : 0));
  };
  child.once("error", (error) => {
    output.write(`[TorPlay] Launcher error: ${error.message}\n`);
    finish(1);
  });
  child.once("exit", finish);
  return child;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) runInstalledRuntime();
