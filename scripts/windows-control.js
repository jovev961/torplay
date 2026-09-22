import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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

export function runtimeStatusIsActive(status) {
  return Boolean(status?.pid && status.state !== "stopped");
}

function readRuntimeLock(lockPath) {
  if (!lockPath || !existsSync(lockPath)) return null;
  try {
    return JSON.parse(readFileSync(lockPath, "utf8"));
  } catch {
    return null;
  }
}

export function runtimeOwnership(status, lock) {
  if (!runtimeStatusIsActive(status)) return null;
  const modern = Boolean(status.instanceId || status.runnerPid);
  if (modern && (!status.instanceId
    || status.instanceId !== lock?.token
    || status.pid !== lock?.pid
    || status.runnerPid !== lock?.runnerPid)) return null;
  return {
    legacy: !modern,
    supervisorPid: status.pid,
    runnerPid: modern ? status.runnerPid : null,
  };
}

function ownershipProcessesStopped(ownership, isRunning) {
  return [ownership.supervisorPid, ownership.runnerPid]
    .filter((pid, index, values) => pid && values.indexOf(pid) === index)
    .every((pid) => !isRunning(pid));
}

function ownershipProcessesRunning(ownership, isRunning) {
  return Boolean(ownership) && [ownership.supervisorPid, ownership.runnerPid]
    .filter((pid, index, values) => pid && values.indexOf(pid) === index)
    .every((pid) => isRunning(pid));
}

function ownershipHasRunningProcess(ownership, isRunning) {
  return Boolean(ownership) && [ownership.supervisorPid, ownership.runnerPid]
    .some((pid) => pid && isRunning(pid));
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
  readLock = readRuntimeLock,
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
    const ownership = runtimeOwnership(snapshot, readLock(paths.lockPath));
    if (belongsToNewStart && snapshot.state === "ready" && ownershipProcessesRunning(ownership, isRunning)) {
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
  readLock = readRuntimeLock,
  isRunning = processIsRunning,
  sendControl = sendControlCommand,
  waitProcess = wait,
} = {}) {
  const status = readStatus(paths.statusPath);
  if (!runtimeStatusIsActive(status)) {
    return { stopped: false, forced: false };
  }
  const ownership = runtimeOwnership(status, readLock(paths.lockPath));
  if (ownership ? !ownershipHasRunningProcess(ownership, isRunning) : !isRunning(status.pid)) {
    return { stopped: false, forced: false };
  }
  try {
    await sendControl({ endpoint: controlEndpoint(installedEnvironment(paths, environment)) });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const processesStopped = ownership
        ? ownershipProcessesStopped(ownership, isRunning)
        : !isRunning(status.pid);
      if (processesStopped) return { stopped: true, forced: false };
      await waitProcess(250);
    }
  } catch {
    // Fall back only when the recorded process ownership is trustworthy.
  }
  if (!ownership) {
    throw new Error("TorPlay runtime ownership could not be verified. No process was terminated.");
  }
  const rootPid = ownership.runnerPid && isRunning(ownership.runnerPid)
    ? ownership.runnerPid
    : ownership.supervisorPid;
  const result = spawnSyncProcess("taskkill.exe", ["/PID", String(rootPid), "/T", "/F"], {
    windowsHide: true,
    stdio: "ignore",
  });
  if ((result.error || result.status !== 0) && !ownershipProcessesStopped(ownership, isRunning)) {
    throw new Error("TorPlay could not stop its existing process. See the runtime log for details.");
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (ownershipProcessesStopped(ownership, isRunning)) return { stopped: true, forced: true };
    await waitProcess(250);
  }
  throw new Error("TorPlay process remained active after forced shutdown. See the runtime log for details.");
}

export async function startInstalledRuntime({
  paths = installedPaths(),
  spawnProcess = spawn,
  fetchProcess = fetch,
  readStatus = readRuntimeStatus,
  readLock = readRuntimeLock,
  isRunning = processIsRunning,
  waitForReady = waitForInstalledRuntime,
  stopRuntime = stopInstalledRuntime,
} = {}) {
  const existing = readStatus(paths.statusPath);
  if (runtimeStatusIsActive(existing)) {
    const ownership = runtimeOwnership(existing, readLock(paths.lockPath));
    if (!ownership && isRunning(existing.pid)) {
      throw new Error("TorPlay runtime ownership could not be verified. No new process was started.");
    }
    if (ownershipHasRunningProcess(ownership, isRunning)) {
      if (!ownershipProcessesRunning(ownership, isRunning)) {
        await stopRuntime({ paths, readStatus, readLock, isRunning });
      } else {
        if (existing.state === "ready" && await healthIsReady(fetchProcess)) {
          return { started: false, snapshot: existing };
        }
        const snapshot = await waitForReady({
          paths,
          previousStartedAt: null,
          fetchProcess,
          readStatus,
          readLock,
          isRunning,
        });
        return { started: false, snapshot };
      }
    }
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
        readLock,
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
  const running = runtimeStatusIsActive(snapshot) && processIsRunning(snapshot.pid);
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
  main().then(() => {
    process.exit(0);
  }, (error) => {
    console.error(`[TorPlay] ${error.message}`);
    process.exit(1);
  });
}
