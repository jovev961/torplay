import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, constants, openSync } from "node:fs";
import {
  access, chmod, cp, mkdir, open, readFile, rename, rm, unlink, writeFile,
} from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startMdnsAdvertisement, startReverseProxy } from "./home-network.js";
import { readLocalEnvironment } from "./local-environment.js";
import { linuxPaths, linuxRuntimeEnvironment } from "./linux-paths.js";
import { sendControlCommand, startControlServer } from "./runtime-control.js";
import { createStatusReporter } from "../platform/runtime/status.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const NEXT_RUNTIME_LAYOUT_VERSION = 2;

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

function configuredPort(value, fallback, name) {
  const raw = String(value ?? "").trim();
  const port = raw ? Number(raw) : fallback;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer from 1 to 65535.`);
  }
  return port;
}

export function linuxLanConfig(environment = process.env) {
  const publicHostname = String(environment.TORPLAY_PUBLIC_HOSTNAME || "torplay.local")
    .trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.local$/.test(publicHostname)) {
    throw new Error("TORPLAY_PUBLIC_HOSTNAME must be a single valid .local hostname.");
  }
  return {
    publicHostname,
    publicPort: configuredPort(environment.TORPLAY_PUBLIC_PORT, 80, "TORPLAY_PUBLIC_PORT"),
    mdnsInterface: environment.TORPLAY_MDNS_INTERFACE?.trim() || null,
  };
}

function waitForCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore", ...options });
    child.once("error", (error) => resolve({ code: null, error }));
    child.once("exit", (code) => resolve({ code, error: null }));
  });
}

async function firstExecutable(candidates) {
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch { /* Try the next known executable. */ }
  }
  return null;
}

async function confirmPolicyKitInstall() {
  const text = "TorPlay needs PolicyKit to request port 80. Install it now? If you cancel, TorPlay will use port 3000.";
  const zenity = await firstExecutable(["/usr/bin/zenity", "/bin/zenity"]);
  if (zenity) {
    return (await waitForCommand(zenity, [
      "--question", "--title=TorPlay network setup", `--text=${text}`,
      "--ok-label=Install", "--cancel-label=Use port 3000",
    ])).code === 0;
  }
  const kdialog = await firstExecutable(["/usr/bin/kdialog", "/bin/kdialog"]);
  if (kdialog) {
    return (await waitForCommand(kdialog, [
      "--title", "TorPlay network setup", "--yesno", text,
      "--yes-label", "Install", "--no-label", "Use port 3000",
    ])).code === 0;
  }
  return false;
}

function osReleaseValues(source) {
  return Object.fromEntries(String(source || "").split("\n").flatMap((line) => {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (!match) return [];
    return [[match[1], match[2].trim().replace(/^(["'])(.*)\1$/, "$2")]];
  }));
}

export function policyKitInstallCommand(source) {
  const values = osReleaseValues(source);
  const family = `${values.ID || ""} ${values.ID_LIKE || ""}`.toLowerCase().split(/\s+/);
  if (family.some((value) => ["ubuntu", "debian", "linuxmint", "pop"].includes(value))) {
    return ["apt-get", "install", "-y", "policykit-1"];
  }
  if (family.some((value) => ["fedora", "rhel", "centos"].includes(value))) {
    return ["dnf", "install", "-y", "polkit"];
  }
  if (family.includes("arch")) return ["pacman", "-S", "--needed", "--noconfirm", "polkit"];
  if (family.some((value) => ["suse", "opensuse"].includes(value))) {
    return ["zypper", "--non-interactive", "install", "polkit"];
  }
  return null;
}

async function installPolicyKit(paths) {
  if (!await confirmPolicyKitInstall()) return false;
  const release = await readFile("/etc/os-release", "utf8").catch(() => "");
  const install = policyKitInstallCommand(release);
  if (!install) return false;
  const terminal = await firstExecutable([
    "/usr/bin/gnome-terminal", "/usr/bin/konsole", "/usr/bin/x-terminal-emulator",
  ]);
  if (!terminal) return false;

  const script = path.join(paths.runtime, "install-policykit.sh");
  await writeFile(script, [
    "#!/bin/sh", "set -eu", `sudo ${install.join(" ")}`,
    "printf '\\nPolicyKit installed. You can close this window.\\n'", "sleep 2", "",
  ].join("\n"), { mode: 0o700 });
  const terminalArgs = terminal.endsWith("gnome-terminal")
    ? ["--wait", "--", "/bin/sh", script]
    : terminal.endsWith("konsole")
      ? ["--nofork", "-e", "/bin/sh", script]
      : ["-e", "/bin/sh", script];
  const result = await waitForCommand(terminal, terminalArgs);
  await rm(script, { force: true });
  return result.code === 0 && Boolean(await firstExecutable(["/usr/bin/pkexec", "/bin/pkexec"]));
}

export async function requestPrivilegedPort({
  paths,
  node = process.execPath,
  helperEntry = bundledPath("linux-port-helper.mjs"),
} = {}) {
  let pkexec = await firstExecutable(["/usr/bin/pkexec", "/bin/pkexec"]);
  if (!pkexec) {
    if (!await installPolicyKit(paths)) return false;
    pkexec = await firstExecutable(["/usr/bin/pkexec", "/bin/pkexec"]);
  }
  if (!pkexec) return false;
  return (await waitForCommand(pkexec, [node, helperEntry, "--enable-port-80"])).code === 0;
}

export function probePublicPort(port, { createServer = net.createServer } = {}) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", (error) => resolve({ available: false, code: error.code || "UNKNOWN" }));
    server.listen(port, "0.0.0.0", () => {
      server.close(() => resolve({ available: true, code: null }));
    });
  });
}

export async function resolveLinuxLanConfig(config, {
  probePort = probePublicPort,
  authorizePort = requestPrivilegedPort,
  fallbackPort = 3000,
} = {}) {
  if (config.publicPort >= 1024) return config;
  const initial = await probePort(config.publicPort);
  if (initial.available) return config;
  if (new Set(["EACCES", "EPERM"]).has(initial.code) && await authorizePort()) {
    const authorized = await probePort(config.publicPort);
    if (authorized.available) return config;
  }
  return { ...config, publicPort: fallbackPort, fallbackFromPort: config.publicPort };
}

function formatHttpUrl(hostname, port) {
  return `http://${hostname}${port === 80 ? "" : `:${port}`}`;
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
  const readyValue = `${buildId}:${NEXT_RUNTIME_LAYOUT_VERSION}`;
  try {
    if ((await readFile(readyPath, "utf8")).trim() === readyValue) {
      return path.join(runtimeRoot, "server.js");
    }
  } catch { /* Create or repair the writable runtime below. */ }

  const temporaryRoot = `${runtimeRoot}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(paths.nextRuntimePath, { recursive: true, mode: 0o700 });
  await rm(runtimeRoot, { recursive: true, force: true });
  await rm(temporaryRoot, { recursive: true, force: true });
  try {
    await cp(packagedRoot, temporaryRoot, {
      recursive: true,
      verbatimSymlinks: true,
    });
    const nextCache = path.join(temporaryRoot, ".next/cache");
    await mkdir(nextCache, { recursive: true, mode: 0o700 });
    await chmod(nextCache, 0o700);
    await writeFile(path.join(temporaryRoot, ".torplay-runtime-ready"), `${readyValue}\n`, { mode: 0o600 });
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
  startProxy = startReverseProxy,
  startMdns = startMdnsAdvertisement,
  resolveLan = resolveLinuxLanConfig,
  authorizePort,
} = {}) {
  await ensureLinuxDirectories(paths);
  const fileEnvironment = readLocalEnvironment(paths.configPath);
  const loaded = linuxRuntimeEnvironment(paths, { ...fileEnvironment, ...environment });
  const configuredLan = linuxLanConfig(loaded);
  const lan = await resolveLan(configuredLan, {
    authorizePort: authorizePort || (() => requestPrivilegedPort({ paths, node })),
  });
  const port = await availableLoopbackPort();
  const lock = await acquireLinuxLock(paths, lan.publicPort);
  const url = formatHttpUrl("127.0.0.1", lock.port);
  let networkUrl = formatHttpUrl(lan.publicHostname, lock.port);
  if (!lock.owner) {
    await waitForHealth(url, null, 30_000);
    if (!await openBrowser(url)) throw new Error(`Could not open a browser. Open ${url} manually.`);
    return { existing: true, url };
  }

  let logFd = openSync(paths.logPath, "a", 0o600);
  if (lan.fallbackFromPort) {
    appendFileSync(paths.logPath,
      `[TorPlay] Port ${lan.fallbackFromPort} authorization was unavailable; using port ${lan.publicPort}.\n`);
  }
  const reporter = createStatusReporter(paths.statusPath, {
    pid: process.pid,
    url,
    networkUrl,
    logPath: paths.logPath,
    components: { TorPlay: "WAITING", "LAN proxy": "WAITING", "mDNS": "WAITING" },
  });
  let child;
  let control;
  let proxy;
  let mdns;
  let stopping = false;
  let stopPromise;
  const stop = () => {
    stopPromise ??= (async () => {
      if (stopping) return;
      stopping = true;
      const errors = [];
      const attempt = async (operation) => {
        try { await operation(); } catch (error) { errors.push(error); }
      };
      reporter.write({
        state: "stopping",
        components: { TorPlay: "STOPPING", "LAN proxy": "STOPPING", "mDNS": "STOPPING" },
      });
      await attempt(async () => control?.close());
      await attempt(async () => mdns?.stop());
      await attempt(async () => proxy?.stop());
      await attempt(async () => stopChild(child));
      await attempt(async () => releaseLinuxLock(paths, lock.token));
      reporter.write({
        state: "stopped",
        lastError: errors[0]?.message || null,
        components: { TorPlay: "STOPPED", "LAN proxy": "STOPPED", "mDNS": "STOPPED" },
      });
      if (logFd !== null) { closeSync(logFd); logFd = null; }
      if (errors.length) throw new AggregateError(errors, "TorPlay shutdown encountered errors.");
    })();
    return stopPromise;
  };

  try {
    mdns = await startMdns({
      hostname: lan.publicHostname,
      port: lan.publicPort,
      mdnsInterface: lan.mdnsInterface,
    });
    const publicHostname = mdns.hostname || lan.publicHostname;
    networkUrl = formatHttpUrl(publicHostname, lan.publicPort);
    reporter.write({ networkUrl, components: { mDNS: "OK" } });
    const runtimeServerEntry = writableNextRuntime
      ? await prepareLinuxNextRuntime(paths, serverEntry) : serverEntry;
    const childEnvironment = {
      ...loaded,
      HOSTNAME: "127.0.0.1",
      PORT: String(port),
      TORPLAY_PUBLIC_HOSTNAME: publicHostname,
      TORPLAY_PUBLIC_PORT: String(lan.publicPort),
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
        }), (error) => reporter.write({
          state: "error", lastError: `${message} ${error.message}`, components: { TorPlay: "ERROR" },
        }));
      }
    });
    const internalUrl = formatHttpUrl("127.0.0.1", port);
    await waitForHealth(internalUrl, child);
    reporter.write({ components: { TorPlay: "OK" } });
    proxy = await startProxy({
      targetHost: "127.0.0.1",
      targetPort: port,
      publicHost: "0.0.0.0",
      publicPort: lan.publicPort,
    });
    await waitForHealth(url, child);
    reporter.write({ components: { "LAN proxy": "OK" } });
    control = await startControlServer({
      endpoint: paths.controlPath,
      onStop: () => setTimeout(() => {
        void stop().catch((error) => console.error(`[TorPlay] ${error.message}`));
      }, 350),
    });
    reporter.write({ state: "running" });
    if (!await openBrowser(url)) {
      const message = `TorPlay is running, but no browser opened. Open ${url} manually. Log: ${paths.logPath}`;
      appendFileSync(paths.logPath, `${message}\n`);
      console.error(message);
    }
    return { existing: false, url, networkUrl, child, proxy, mdns, stop, reporter };
  } catch (error) {
    reporter.write({ state: "error", lastError: error.message, components: { TorPlay: "ERROR" } });
    appendFileSync(paths.logPath, `[TorPlay] Startup failed: ${error.message}\n`);
    await stop().catch((shutdownError) => {
      appendFileSync(paths.logPath, `[TorPlay] Shutdown after startup failure: ${shutdownError.message}\n`);
    });
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
    process.once(signal, () => {
      void runtime.stop().catch((error) => console.error(`[TorPlay] ${error.message}`));
    });
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
