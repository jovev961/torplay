import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { controlEndpoint, sendControlCommand } from "./runtime-control.js";
import { readRuntimeStatus } from "../platform/runtime/status.js";
import { installedEnvironment, installedPaths } from "./windows-paths.js";

export function processIsRunning(pid, killProcess = process.kill) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    killProcess(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function healthIsReady(fetchProcess) {
  try {
    const response = await fetchProcess("http://127.0.0.1/api/health", {
      cache: "no-store",
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function waitForInstalledRuntime({
  paths = installedPaths(),
  previousStartedAt = null,
  fetchProcess = fetch,
  readStatus = readRuntimeStatus,
  isRunning = processIsRunning,
  waitProcess = wait,
  timeoutMs = 60_000,
  intervalMs = 250,
  now = Date.now,
} = {}) {
  const deadline = now() + timeoutMs;
  let lastFailure = null;
  while (now() < deadline) {
    const snapshot = readStatus(paths.statusPath);
    const belongsToNewStart = snapshot?.startedAt
      && snapshot.startedAt !== previousStartedAt;
    if (belongsToNewStart && snapshot.state === "error") {
      throw new Error(snapshot.lastError || "TorPlay failed while starting.");
    }
    if (belongsToNewStart && snapshot.state === "ready" && isRunning(snapshot.pid)) {
      if (await healthIsReady(fetchProcess)) return snapshot;
      lastFailure = "the health check is not ready";
    } else if (snapshot?.state) {
      lastFailure = `runtime state is ${snapshot.state}`;
    }
    await waitProcess(intervalMs);
  }
  throw new Error(
    `TorPlay did not become ready within ${Math.ceil(timeoutMs / 1_000)} seconds${lastFailure ? ` (${lastFailure})` : ""}. See the runtime log for details.`,
  );
}

export async function stopInstalledRuntime({
  paths = installedPaths(),
  environment = process.env,
  spawnSyncProcess = spawnSync,
  readStatus = readRuntimeStatus,
  isRunning = processIsRunning,
  sendControl = sendControlCommand,
  waitProcess = wait,
} = {}) {
  const status = readStatus(paths.statusPath);
  if (!isRunning(status?.pid)) return { stopped: false, forced: false };
  try {
    await sendControl({ endpoint: controlEndpoint(installedEnvironment(paths, environment)) });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (!isRunning(status.pid)) return { stopped: true, forced: false };
      await waitProcess(250);
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
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!isRunning(status.pid)) return { stopped: true, forced: true };
    await waitProcess(250);
  }
  throw new Error("TorPlay process remained active after forced shutdown. See the runtime log for details.");
}

export async function startInstalledRuntime({
  paths = installedPaths(),
  spawnProcess = spawn,
  fetchProcess = fetch,
  readStatus = readRuntimeStatus,
  isRunning = processIsRunning,
  waitForReady = waitForInstalledRuntime,
} = {}) {
  const existing = readStatus(paths.statusPath);
  if (isRunning(existing?.pid)) {
    if (existing.state === "ready" && await healthIsReady(fetchProcess)) {
      return { started: false, snapshot: existing };
    }
    const snapshot = await waitForReady({
      paths,
      previousStartedAt: null,
      fetchProcess,
      readStatus,
      isRunning,
    });
    return { started: false, snapshot };
  }
  const child = spawnProcess("wscript.exe", [paths.launcherPath, "start"], {
    cwd: paths.installDir,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref?.();
  let onLaunchError;
  const launchError = new Promise((_, reject) => {
    onLaunchError = (error) => reject(new Error(`TorPlay launcher could not start: ${error.message}`));
    child.once?.("error", onLaunchError);
  });
  try {
    const snapshot = await Promise.race([
      waitForReady({
        paths,
        previousStartedAt: existing?.startedAt || null,
        fetchProcess,
        readStatus,
        isRunning,
      }),
      launchError,
    ]);
    return { started: true, snapshot };
  } finally {
    child.removeListener?.("error", onLaunchError);
  }
}

export async function restartInstalledRuntime({
  stopRuntime = stopInstalledRuntime,
  startRuntime = startInstalledRuntime,
  ...options
} = {}) {
  await stopRuntime(options);
  return startRuntime(options);
}

export async function runtimeStatus({
  paths = installedPaths(),
  fetchProcess = fetch,
} = {}) {
  const snapshot = readRuntimeStatus(paths.statusPath);
  const running = processIsRunning(snapshot?.pid);
  const components = {
    TorPlay: "ERROR",
    "LAN proxy": "ERROR",
    "mDNS": running && snapshot?.components?.["mDNS"] === "OK" ? "OK" : "ERROR",
  };
  try {
    const response = await fetchProcess("http://127.0.0.1/api/health", {
      cache: "no-store",
      signal: AbortSignal.timeout(2_000),
    });
    if (response.ok && running) {
      if (snapshot?.components?.TorPlay === "OK") components.TorPlay = "OK";
      if (snapshot?.components?.["LAN proxy"] === "OK") components["LAN proxy"] = "OK";
    }
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
    await startInstalledRuntime({ paths });
    return;
  }
  if (command === "stop") {
    await stopInstalledRuntime({ paths });
    return;
  }
  if (command === "restart") {
    await restartInstalledRuntime({ paths });
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
