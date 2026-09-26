import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, openSync } from "node:fs";
import {
  chmod, copyFile, cp, mkdir, open, readFile, readdir, rename, rm, symlink, unlink, writeFile,
} from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readLocalEnvironment } from "./local-environment.js";
import { linuxPaths, linuxRuntimeEnvironment } from "./linux-paths.js";
import { sendControlCommand, startControlServer } from "./runtime-control.js";
import { createStatusReporter } from "../platform/runtime/status.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function availableLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

export async function ensureLinuxDirectories(paths) {
  for (const directory of [paths.config, paths.data, paths.cache, paths.state, paths.runtime]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }
  const file = await open(paths.configPath, "a", 0o600);
  await file.close();
  await chmod(paths.configPath, 0o600);
}

export async function prepareLinuxNextRuntime(paths, serverEntry) {
  const packagedRoot = path.dirname(serverEntry);
  const packagedNext = path.join(packagedRoot, ".next");
  const buildId = (await readFile(path.join(packagedNext, "BUILD_ID"), "utf8")).trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(buildId)) throw new Error("The packaged Next.js build ID is invalid.");
  const runtimeRoot = path.join(paths.nextRuntimePath, buildId);
  const readyPath = path.join(runtimeRoot, ".torplay-runtime-ready");
  try {
    if ((await readFile(readyPath, "utf8")).trim() === buildId) {
      return path.join(runtimeRoot, "server.js");
    }
  } catch { /* Create or repair the writable runtime below. */ }

  const temporaryRoot = `${runtimeRoot}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(paths.nextRuntimePath, { recursive: true, mode: 0o700 });
  await rm(runtimeRoot, { recursive: true, force: true });
  await rm(temporaryRoot, { recursive: true, force: true });
  await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
  try {
    await copyFile(serverEntry, path.join(temporaryRoot, "server.js"));
    await cp(packagedNext, path.join(temporaryRoot, ".next"), {
      recursive: true,
      verbatimSymlinks: true,
    });
    await mkdir(path.join(temporaryRoot, ".next/cache"), { recursive: true, mode: 0o700 });
    for (const entry of await readdir(packagedRoot, { withFileTypes: true })) {
      if (entry.name === ".next" || entry.name === "server.js" || entry.name.startsWith(".env")) continue;
      await symlink(path.join(packagedRoot, entry.name), path.join(temporaryRoot, entry.name),
        entry.isDirectory() ? "dir" : "file");
    }
    await writeFile(path.join(temporaryRoot, ".torplay-runtime-ready"), `${buildId}\n`, { mode: 0o600 });
    await rename(temporaryRoot, runtimeRoot);
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
  return path.join(runtimeRoot, "server.js");
}

async function liveTorPlayProcess(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    const command = await readFile(`/proc/${pid}/cmdline`, "utf8");
    return command.includes("linux-launcher.mjs") || command.includes("linux-launcher.js");
  } catch {
    return false;
  }
}

async function readLock(lockPath) {
  try { return JSON.parse(await readFile(lockPath, "utf8")); } catch { return null; }
}

export async function acquireLinuxLock(paths, port) {
  const token = randomUUID();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const file = await open(paths.lockPath, "wx", 0o600);
      await file.writeFile(JSON.stringify({ pid: process.pid, port, token }));
      await file.close();
      return { owner: true, token, port };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = await readLock(paths.lockPath);
      if (await liveTorPlayProcess(existing?.pid)) {
        return { owner: false, port: existing.port };
      }
      await unlink(paths.lockPath).catch((unlinkError) => {
        if (unlinkError.code !== "ENOENT") throw unlinkError;
      });
      await unlink(paths.controlPath).catch((unlinkError) => {
        if (unlinkError.code !== "ENOENT") throw unlinkError;
      });
    }
  }
  throw new Error("TorPlay could not acquire its runtime lock.");
}

async function releaseLinuxLock(paths, token) {
  if ((await readLock(paths.lockPath))?.token === token) {
    await unlink(paths.lockPath).catch(() => {});
    await unlink(paths.controlPath).catch(() => {});
  }
}

export async function waitForHealth(url, child, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) throw new Error("The TorPlay server exited during startup.");
    if (child && !child.pid) throw new Error("The TorPlay server could not be spawned.");
    try {
      const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1_500) });
      if (response.ok) return;
    } catch { /* Retry until the deadline. */ }
    await delay(250);
  }
  throw new Error(`TorPlay did not become healthy at ${url}.`);
}

async function openWith(command, url) {
  return new Promise((resolve) => {
    const child = spawn(command, [url], { detached: true, stdio: "ignore" });
    let settled = false;
    const done = (success) => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve(success);
    };
    child.once("error", () => done(false));
    child.once("exit", (code) => done(code === 0));
    setTimeout(() => done(true), 8_000).unref();
  });
}

export async function openLinuxBrowser(url) {
  return await openWith("xdg-open", url) || await openWith("gio", url);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  const exit = new Promise((resolve) => {
    const onExit = () => { clearTimeout(timer); resolve(true); };
    const timer = setTimeout(() => { child.removeListener("exit", onExit); resolve(false); }, 5_000);
    child.once("exit", onExit);
  });
  child.kill("SIGTERM");
  const exited = await exit;
  if (!exited && child.exitCode === null) child.kill("SIGKILL");
}

function bundledPath(name) {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), name);
}

export async function startLinuxApp({
  environment = process.env,
  paths = linuxPaths(environment),
  node = process.execPath,
  serverEntry = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "app", "server.js"),
  watchdogEntry = bundledPath("runtime-watchdog.mjs"),
  openBrowser = openLinuxBrowser,
  writableNextRuntime = false,
} = {}) {
  await ensureLinuxDirectories(paths);
  const port = await availableLoopbackPort();
  const lock = await acquireLinuxLock(paths, port);
  const url = `http://127.0.0.1:${lock.port}`;
  if (!lock.owner) {
    await waitForHealth(url, null, 30_000);
    if (!await openBrowser(url)) throw new Error(`Could not open a browser. Open ${url} manually.`);
    return { existing: true, url };
  }

  let logFd = openSync(paths.logPath, "a", 0o600);
  const reporter = createStatusReporter(paths.statusPath, {
    pid: process.pid, url, logPath: paths.logPath, components: { TorPlay: "WAITING" },
  });
  let child;
  let control;
  let stopping = false;
  let stopPromise;
  const stop = () => {
    stopPromise ??= (async () => {
      if (stopping) return;
      stopping = true;
      reporter.write({ state: "stopping", components: { TorPlay: "STOPPING" } });
      await control?.close();
      await stopChild(child);
      await releaseLinuxLock(paths, lock.token);
      reporter.write({ state: "stopped", components: { TorPlay: "STOPPED" } });
      if (logFd !== null) { closeSync(logFd); logFd = null; }
    })();
    return stopPromise;
  };

  try {
    const runtimeServerEntry = writableNextRuntime
      ? await prepareLinuxNextRuntime(paths, serverEntry) : serverEntry;
    const fileEnvironment = readLocalEnvironment(paths.configPath);
    const loaded = linuxRuntimeEnvironment(paths, { ...fileEnvironment, ...environment });
    const childEnvironment = {
      ...loaded,
      HOSTNAME: "127.0.0.1",
      PORT: String(port),
      TORPLAY_PUBLIC_PORT: String(port),
      TORPLAY_SUPERVISOR_PID: String(process.pid),
      NODE_OPTIONS: [loaded.NODE_OPTIONS, `--import=${pathToFileURL(watchdogEntry).href}`].filter(Boolean).join(" "),
    };
    child = spawn(node, [runtimeServerEntry], {
      cwd: path.dirname(runtimeServerEntry), env: childEnvironment, stdio: ["ignore", logFd, logFd],
    });
    closeSync(logFd);
    logFd = null;
    child.once("error", (error) => {
      reporter.write({ state: "error", lastError: error.message, components: { TorPlay: "ERROR" } });
    });
    child.once("exit", (code) => {
      if (!stopping) {
        const message = `Server exited with code ${code}.`;
        void stop().then(() => reporter.write({
          state: "error", lastError: message, components: { TorPlay: "ERROR" },
        }));
      }
    });
    await waitForHealth(url, child);
    control = await startControlServer({
      endpoint: paths.controlPath,
      onStop: () => setTimeout(() => void stop(), 350),
    });
    reporter.write({ state: "running", components: { TorPlay: "OK" } });
    if (!await openBrowser(url)) {
      const message = `TorPlay is running, but no browser opened. Open ${url} manually. Log: ${paths.logPath}`;
      appendFileSync(paths.logPath, `${message}\n`);
      console.error(message);
    }
    return { existing: false, url, child, stop, reporter };
  } catch (error) {
    reporter.write({ state: "error", lastError: error.message, components: { TorPlay: "ERROR" } });
    appendFileSync(paths.logPath, `[TorPlay] Startup failed: ${error.message}\n`);
    await stop();
    reporter.write({ state: "error", lastError: error.message, components: { TorPlay: "ERROR" } });
    throw error;
  }
}

async function main() {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("This TorPlay AppImage requires Linux x86_64.");
  }
  const paths = linuxPaths();
  if (process.argv.includes("--stop")) {
    await sendControlCommand({ endpoint: paths.controlPath });
    return;
  }
  if (process.argv.includes("--status")) {
    console.log(await readFile(paths.statusPath, "utf8"));
    return;
  }
  const runtime = await startLinuxApp({ paths, writableNextRuntime: true });
  if (runtime.existing) return;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.once(signal, () => void runtime.stop());
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[TorPlay] ${error.message}`);
    const dialog = spawn("zenity", ["--error", "--title=TorPlay", `--text=TorPlay could not start.\n${error.message}\nSee the TorPlay log for details.`], {
      detached: true, stdio: "ignore",
    });
    dialog.once("error", () => {});
    dialog.unref();
    process.exitCode = 1;
  });
}
