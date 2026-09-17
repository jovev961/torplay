import { spawn } from "node:child_process";
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

export function runInstalledRuntime({
  paths = installedPaths(),
  environment = process.env,
  spawnProcess = spawn,
} = {}) {
  const runtimeEnvironment = installedEnvironment(paths, environment);
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
  child.on("error", (error) => output.write(`[TorPlay] Launcher error: ${error.message}\n`));
  child.on("exit", (code, signal) => {
    output.write(
      `[${new Date().toISOString()}] TorPlay exited${signal ? ` with ${signal}` : ` with code ${code}`}.\n`,
    );
    process.exitCode = code || (signal ? 1 : 0);
  });
  return child;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) runInstalledRuntime();
