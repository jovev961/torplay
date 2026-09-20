import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { controlEndpoint, sendControlCommand } from "./runtime-control.js";
import { readRuntimeStatus } from "./runtime-status.js";
import { installedEnvironment, installedPaths } from "./windows-paths.js";

function processIsRunning(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function stopInstalledRuntime({
  paths = installedPaths(),
  environment = process.env,
  spawnSyncProcess = spawnSync,
} = {}) {
  const status = readRuntimeStatus(paths.statusPath);
  if (!processIsRunning(status?.pid)) return { stopped: false, forced: false };
  try {
    await sendControlCommand({ endpoint: controlEndpoint(installedEnvironment(paths, environment)) });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (!processIsRunning(status.pid)) return { stopped: true, forced: false };
      await wait(250);
    }
  } catch {
    // Fall back to terminating only the recorded TorPlay process tree.
  }
  const result = spawnSyncProcess("taskkill.exe", ["/PID", String(status.pid), "/T", "/F"], {
    windowsHide: true,
    stdio: "ignore",
  });
  if (result.error || result.status !== 0) {
    throw new Error("TorPlay could not stop its existing process. See the runtime log for details.");
  }
  return { stopped: true, forced: true };
}

export function startInstalledRuntime({ paths = installedPaths(), spawnProcess = spawn } = {}) {
  const child = spawnProcess("wscript.exe", [paths.launcherPath, "start"], {
    cwd: paths.installDir,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref?.();
}

export async function runtimeStatus({
  paths = installedPaths(),
  fetchProcess = fetch,
} = {}) {
  const snapshot = readRuntimeStatus(paths.statusPath);
  const running = processIsRunning(snapshot?.pid);
  const components = {
    TorPlay: "ERROR",
    "mDNS": running && snapshot?.components?.["mDNS"] === "OK" ? "OK" : "ERROR",
  };
  try {
    const response = await fetchProcess("http://127.0.0.1/api/health", {
      cache: "no-store",
      signal: AbortSignal.timeout(2_000),
    });
    if (response.ok) components.TorPlay = "OK";
  } catch {
    components.TorPlay = "ERROR";
  }
  return { components, snapshot, paths };
}

export function formatStatus({ components, snapshot, paths }) {
  const lines = Object.entries(components).map(
    ([name, value]) => `${name.padEnd(14)} ${value}`,
  );
  lines.push("", "Open on this computer:", "http://localhost", "", "Open on household devices:", "http://torplay.local", "", `Config: ${paths.configPath}`, `Logs:   ${paths.logPath}`);
  if (snapshot?.lastError) lines.push("", `Last failure: ${snapshot.lastError}`);
  return lines.join("\n");
}

export async function main(command = process.argv[2] || "status") {
  const paths = installedPaths();
  if (existsSync(paths.installDir)) process.chdir(paths.installDir);
  if (command === "start") {
    startInstalledRuntime({ paths });
    return;
  }
  if (command === "stop") {
    await stopInstalledRuntime({ paths });
    return;
  }
  if (command === "restart") {
    await stopInstalledRuntime({ paths });
    startInstalledRuntime({ paths });
    return;
  }
  if (command === "status") {
    console.log(formatStatus(await runtimeStatus({ paths })));
    return;
  }
  throw new Error("Usage: windows-control.mjs <start|restart|stop|status>");
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(`[TorPlay] ${error.message}`);
    process.exitCode = 1;
  });
}
