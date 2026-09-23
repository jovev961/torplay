import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startMdnsAdvertisement, startReverseProxy } from "./home-network.js";
import { readLocalEnvironment } from "./local-environment.js";
import { controlEndpoint, startControlServer } from "./runtime-control.js";
import { createComponentRecovery, startHealthMonitor } from "./runtime-recovery.js";
import { createStatusReporter } from "../platform/runtime/status.js";
import { SETTINGS_ENVIRONMENT_KEYS } from "../lib/settings/definitions.js";

const require = createRequire(import.meta.url);
export function loadHomeEnvironment({ cwd = process.cwd(), environment = process.env } = {}) {
  const configPath = environment.TORPLAY_CONFIG_PATH || path.join(cwd, ".env.local");
  const fileEnvironment = readLocalEnvironment(configPath);
  const externalKeys = SETTINGS_ENVIRONMENT_KEYS.filter((key) => Object.hasOwn(environment, key));
  const loaded = { ...fileEnvironment, ...environment };
  loaded.TORPLAY_EXTERNAL_CONFIG_KEYS = externalKeys.join(",");
  loaded.TORPLAY_DATABASE_PATH ||= environment.TORPLAY_DEFAULT_DATABASE_PATH;
  loaded.TORRENT_DOWNLOAD_PATH ||= environment.TORPLAY_DEFAULT_TORRENT_PATH;
  loaded.SUBTITLE_CACHE_PATH ||= environment.TORPLAY_DEFAULT_SUBTITLE_PATH;
  return loaded;
}

function parsePort(value, fallback, name) {
  const raw = String(value ?? "").trim();
  const port = raw ? Number(raw) : fallback;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer from 1 to 65535.`);
  }
  return port;
}

export function parseHomeConfig(environment = process.env) {
  const host = environment.TORPLAY_HOST?.trim() || "127.0.0.1";
  if (!new Set(["127.0.0.1", "localhost", "0.0.0.0"]).has(host)) {
    throw new Error("TORPLAY_HOST must be 127.0.0.1, localhost, or 0.0.0.0.");
  }

  const port = parsePort(environment.TORPLAY_PORT, 3000, "TORPLAY_PORT");
  const publicPort = parsePort(environment.TORPLAY_PUBLIC_PORT, 80, "TORPLAY_PUBLIC_PORT");
  if (port === publicPort) {
    throw new Error("TORPLAY_PORT and TORPLAY_PUBLIC_PORT must be different.");
  }

  const publicHostname = (environment.TORPLAY_PUBLIC_HOSTNAME?.trim() || "torplay.local").toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.local$/.test(publicHostname)) {
    throw new Error("TORPLAY_PUBLIC_HOSTNAME must be a single valid .local hostname.");
  }

  const mdnsInterface = environment.TORPLAY_MDNS_INTERFACE?.trim() || null;
  return {
    host,
    port,
    publicHost: "0.0.0.0",
    publicPort,
    publicHostname,
    mdnsInterface,
    connectHost: host === "0.0.0.0" ? "127.0.0.1" : host,
  };
}

export function formatHttpUrl(hostname, port) {
  return `http://${hostname}${port === 80 ? "" : `:${port}`}`;
}

export function serverStart(environment, config) {
  const serverEntry = environment.TORPLAY_SERVER_ENTRY?.trim() || null;
  const watchdogEntry = environment.TORPLAY_WATCHDOG_ENTRY?.trim()
    || path.join(path.dirname(fileURLToPath(import.meta.url)), "runtime-watchdog.js");
  const watchdogOption = `--import=${pathToFileURL(watchdogEntry).href}`;
  const childEnvironment = {
    ...environment,
    NODE_ENV: "production",
    TORPLAY_SUPERVISOR_PID: String(process.pid),
    NODE_OPTIONS: [environment.NODE_OPTIONS, watchdogOption].filter(Boolean).join(" "),
  };
  return serverEntry
    ? {
        entry: serverEntry,
        args: [serverEntry],
        environment: { ...childEnvironment, HOSTNAME: config.host, PORT: String(config.port) },
      }
    : {
        entry: path.join(process.cwd(), ".next", "BUILD_ID"),
        args: [require.resolve("next/dist/bin/next"), "start", "-H", config.host, "-p", String(config.port)],
        environment: childEnvironment,
      };
}

function processIsRunning(pid, killProcess = process.kill) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    killProcess(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

export async function acquireRuntimeLock({
  lockPath = path.join(process.cwd(), ".data", "runtime", "home.lock"),
  pid = process.pid,
  runnerPid = null,
  token = randomUUID(),
  killProcess = process.kill,
} = {}) {
  await mkdir(path.dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(JSON.stringify({ pid, runnerPid, token, startedAt: new Date().toISOString() }));
      await handle.close();
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        try {
          const current = JSON.parse(await readFile(lockPath, "utf8"));
          if (current.token === token) await unlink(lockPath);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let existing;
      try {
        existing = JSON.parse(await readFile(lockPath, "utf8"));
      } catch {
        existing = null;
      }
      if (processIsRunning(existing?.pid, killProcess)) {
        throw new Error(`TorPlay home runtime is already running (PID ${existing.pid}).`);
      }
      await unlink(lockPath).catch((unlinkError) => {
        if (unlinkError.code !== "ENOENT") throw unlinkError;
      });
    }
  }
  throw new Error("TorPlay could not acquire its runtime lock.");
}

export function checkPortAvailable(port, host) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", (error) => {
      const detail = error.code === "EADDRINUSE"
        ? `Port ${port} is already in use.`
        : error.code === "EACCES"
          ? `TorPlay does not have permission to bind port ${port}.`
          : `Port ${port} could not be opened: ${error.message}`;
      reject(new Error(detail));
    });
    server.listen(port, host, () => server.close(resolve));
  });
}

function waitForProcess(child, label) {
  return new Promise((resolve, reject) => {
    child.once("error", (error) => reject(new Error(`${label} could not start: ${error.message}`)));
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} failed${signal ? ` with ${signal}` : ` with exit code ${code}`}.`));
    });
  });
}

async function runCommand(spawnProcess, command, args, options, label) {
  const child = spawnProcess(command, args, options);
  await waitForProcess(child, label);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function waitForHttp(url, {
  fetchProcess = fetch,
  timeoutMs = 60_000,
  child,
  intervalMs = 500,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  let childError = null;
  const onChildError = (error) => {
    childError = error;
  };
  child?.on("error", onChildError);
  try {
    while (Date.now() < deadline) {
      if (childError) throw new Error(`TorPlay could not start: ${childError.message}`);
      if (child && (child.exitCode !== null || child.signalCode)) {
        const outcome = child.signalCode || `exit code ${child.exitCode}`;
        throw new Error(`TorPlay exited before becoming ready (${outcome}).`);
      }
      try {
        const response = await fetchProcess(url, {
          cache: "no-store",
          signal: AbortSignal.timeout(2_000),
        });
        if (response.ok) return response;
        lastError = new Error(`HTTP ${response.status}`);
      } catch (error) {
        lastError = error;
      }
      await delay(intervalMs);
    }
  } finally {
    child?.removeListener("error", onChildError);
  }
  throw new Error(`Timed out waiting for ${url}${lastError ? `: ${lastError.message}` : "."}`);
}

async function httpIsHealthy(url, fetchProcess) {
  try {
    const response = await fetchProcess(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function waitForChildExit(child, timeoutMs) {
  if (!child || child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolve(false);
    }, timeoutMs);
    timer.unref?.();
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

async function stopNextProcess(child, {
  platform,
  spawnProcess,
  environment,
} = {}) {
  if (!child || child.exitCode !== null) return;
  if (platform === "win32" && child.pid) {
    try {
      await runCommand(
        spawnProcess,
        "taskkill.exe",
        ["/PID", String(child.pid), "/T", "/F"],
        { stdio: "inherit", env: environment, windowsHide: true },
        "TorPlay process-tree shutdown",
      );
      if (await waitForChildExit(child, 2_000)) return;
    } catch (error) {
      console.error(error.message);
    }
  } else {
    child.kill("SIGINT");
    if (await waitForChildExit(child, 5_000)) return;
  }
  child.kill("SIGKILL");
}

export async function startHomeRuntime({
  platform = process.platform,
  cwd = process.cwd(),
  environment,
  spawnProcess = spawn,
  fetchProcess = fetch,
  startProxyProcess = startReverseProxy,
  startMdnsProcess = startMdnsAdvertisement,
  acquireLockProcess = acquireRuntimeLock,
  checkPortProcess = checkPortAvailable,
  buildExists = existsSync,
  statusReporter,
  log = console.log,
  healthIntervalMs = 15_000,
  healthFailureThreshold = 2,
} = {}) {
  if (platform !== "win32") {
    throw new Error("The TorPlay home runtime currently supports Windows only. Use npm run dev here.");
  }
  environment = environment || loadHomeEnvironment({ cwd });
  const installedServerEntry = environment.TORPLAY_SERVER_ENTRY?.trim() || null;
  if (installedServerEntry
    ? !buildExists(installedServerEntry)
    : !buildExists(path.join(cwd, ".next", "BUILD_ID"))) {
    throw new Error("TorPlay has not been built. Run npm run build, then npm run start:home.");
  }

  const config = parseHomeConfig(environment);
  const runtimeDir = environment.TORPLAY_RUNTIME_DIR || path.join(cwd, ".data", "runtime");
  const reporter = statusReporter || createStatusReporter(environment.TORPLAY_STATUS_PATH, {
    url: formatHttpUrl(config.publicHostname, config.publicPort),
    logPath: environment.TORPLAY_LOG_PATH || null,
  });
  const releaseLock = await acquireLockProcess({
    lockPath: path.join(runtimeDir, "home.lock"),
    pid: process.pid,
    runnerPid: Number(environment.TORPLAY_RUNNER_PID) || null,
    token: environment.TORPLAY_RUNTIME_INSTANCE_ID || undefined,
  });
  const componentStates = { TorPlay: "WAITING", "LAN proxy": "WAITING", "mDNS": "WAITING" };
  const componentErrors = {};
  let nextProcess = null;
  let proxy = null;
  let mdns = null;
  let healthMonitor = null;
  let supervisionStarted = false;
  let startupFailure = null;
  let stopped = false;
  const expectedApplicationStops = new WeakSet();
  const expectedProxyStops = new WeakSet();

  function updateComponent(component, value, error = null) {
    componentStates[component] = value;
    if (error) componentErrors[component] = error.message;
    else delete componentErrors[component];
    const values = Object.values(componentStates);
    const state = values.includes("ERROR")
      ? "error"
      : values.includes("RECOVERING")
        ? "recovering"
        : values.every((entry) => entry === "OK")
          ? "ready"
          : "starting";
    reporter.write({
      state,
      components: { [component]: value },
      lastError: Object.values(componentErrors)[0] || null,
    });
  }

  function applicationFailure(child, error) {
    if (stopped || expectedApplicationStops.has(child) || child !== nextProcess) return;
    if (!supervisionStarted) {
      startupFailure = error;
      return;
    }
    void applicationRecovery.recover(error);
  }

  async function startApplication() {
    if (stopped) throw new Error("TorPlay is shutting down.");
    const server = serverStart(environment, config);
    const child = spawnProcess(
      process.execPath,
      server.args,
      {
        cwd,
        env: server.environment,
        stdio: "inherit",
        windowsHide: true,
      },
    );
    nextProcess = child;
    child.once("error", (error) => {
      applicationFailure(child, new Error(`Application process failed: ${error.message}`));
    });
    child.once("exit", (code, signal) => {
      applicationFailure(
        child,
        new Error(`Application stopped unexpectedly${signal ? ` with ${signal}` : ` (exit ${code})`}.`),
      );
    });
    await waitForHttp(`${formatHttpUrl(config.connectHost, config.port)}/api/health`, {
      fetchProcess,
      child,
    });
    if (startupFailure) throw startupFailure;
    if (stopped) {
      expectedApplicationStops.add(child);
      await stopNextProcess(child, { platform, spawnProcess, environment });
      throw new Error("TorPlay stopped during application recovery.");
    }
    updateComponent("TorPlay", "OK");
    return child;
  }

  async function restartApplication() {
    const previous = nextProcess;
    if (previous) {
      expectedApplicationStops.add(previous);
      await stopNextProcess(previous, { platform, spawnProcess, environment });
      if (nextProcess === previous) nextProcess = null;
    }
    await startApplication();
  }

  function proxyFailure(current, error) {
    if (stopped || expectedProxyStops.has(current) || current !== proxy) return;
    if (!supervisionStarted) {
      startupFailure = error;
      return;
    }
    void proxyRecovery.recover(error);
  }

  async function startProxy() {
    if (stopped) throw new Error("TorPlay is shutting down.");
    const current = await startProxyProcess({
      targetHost: config.connectHost,
      targetPort: config.port,
      publicHost: config.publicHost,
      publicPort: config.publicPort,
    });
    proxy = current;
    current.server?.once("close", () => {
      proxyFailure(current, new Error(`LAN proxy on port ${config.publicPort} stopped unexpectedly.`));
    });
    await waitForHttp(`${formatHttpUrl("127.0.0.1", config.publicPort)}/api/health`, { fetchProcess });
    if (startupFailure) throw startupFailure;
    if (stopped) {
      expectedProxyStops.add(current);
      await current.stop();
      throw new Error("TorPlay stopped during LAN proxy recovery.");
    }
    updateComponent("LAN proxy", "OK");
    return current;
  }

  async function restartProxy() {
    const previous = proxy;
    if (previous) {
      expectedProxyStops.add(previous);
      await previous.stop();
      if (proxy === previous) proxy = null;
    }
    await startProxy();
  }

  async function startMdns() {
    if (stopped) throw new Error("TorPlay is shutting down.");
    const current = await startMdnsProcess({
      hostname: config.publicHostname,
      port: config.publicPort,
      mdnsInterface: config.mdnsInterface,
    });
    if (stopped) {
      await current.stop();
      throw new Error("TorPlay stopped during mDNS recovery.");
    }
    mdns = current;
    updateComponent("mDNS", "OK");
    return current;
  }

  async function restartMdns() {
    const previous = mdns;
    if (previous) {
      await previous.stop();
      if (mdns === previous) mdns = null;
    }
    await startMdns();
  }

  function recoveryOptions(component, restart) {
    return {
      name: component,
      restart,
      log,
      onAttempt: (error) => updateComponent(component, "RECOVERING", error),
      onRecovered: () => updateComponent(component, "OK"),
      onPersistentFailure: (error) => updateComponent(component, "ERROR", error),
    };
  }

  const applicationRecovery = createComponentRecovery(recoveryOptions("TorPlay", restartApplication));
  const proxyRecovery = createComponentRecovery(recoveryOptions("LAN proxy", restartProxy));
  const mdnsRecovery = createComponentRecovery(recoveryOptions("mDNS", restartMdns));
  const recoveries = {
    TorPlay: applicationRecovery,
    "LAN proxy": proxyRecovery,
    "mDNS": mdnsRecovery,
  };

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    supervisionStarted = false;
    reporter.write({ state: "stopping", lastError: null });
    healthMonitor?.stop();
    Object.values(recoveries).forEach((recovery) => recovery.disable());
    log("[TorPlay] Shutting down...");
    const errors = [];
    if (mdns) await mdns.stop().catch((error) => errors.push(error));
    if (proxy) {
      expectedProxyStops.add(proxy);
      await proxy.stop().catch((error) => errors.push(error));
    }
    if (nextProcess) expectedApplicationStops.add(nextProcess);
    await stopNextProcess(nextProcess, { platform, spawnProcess, environment })
      .catch((error) => errors.push(error));
    await releaseLock().catch((error) => errors.push(error));
    reporter.write({
      state: "stopped",
      lastError: errors[0]?.message || null,
      components: { TorPlay: "STOPPED", "LAN proxy": "STOPPED", "mDNS": "STOPPED" },
    });
    log("[TorPlay] Shutdown complete.");
    if (errors.length) throw new AggregateError(errors, "TorPlay shutdown encountered errors.");
  };

  try {
    reporter.write({ state: "starting", lastError: null });
    log("[TorPlay] Starting Windows home runtime...");
    await checkPortProcess(config.port, config.host);
    await checkPortProcess(config.publicPort, config.publicHost);

    await startApplication();
    log("[TorPlay] Application ready.");

    await startProxy();
    log(`[TorPlay] Port ${config.publicPort} frontend ready.`);

    await startMdns();
    if (startupFailure) throw startupFailure;
    supervisionStarted = true;
    log(`[TorPlay] mDNS registered ${config.publicHostname}.`);

    healthMonitor = startHealthMonitor({
      intervalMs: healthIntervalMs,
      failureThreshold: healthFailureThreshold,
      inspect: async () => {
        const internalUrl = `${formatHttpUrl(config.connectHost, config.port)}/api/health`;
        if (!nextProcess || nextProcess.exitCode !== null || !await httpIsHealthy(internalUrl, fetchProcess)) {
          return { component: "TorPlay", error: new Error(`Application health check failed at ${internalUrl}.`) };
        }
        const publicUrl = `${formatHttpUrl("127.0.0.1", config.publicPort)}/api/health`;
        if (!proxy?.isHealthy?.() || !await httpIsHealthy(publicUrl, fetchProcess)) {
          return { component: "LAN proxy", error: new Error(`LAN proxy health check failed at ${publicUrl}.`) };
        }
        if (mdns?.isHealthy && !mdns.isHealthy()) {
          return { component: "mDNS", error: new Error("mDNS advertisement is no longer active.") };
        }
        return null;
      },
      onFailure: ({ component, error }) => recoveries[component].recover(error),
      onError: (error) => log(`[TorPlay] Health monitor error: ${error.message}`),
    });

    const localUrl = formatHttpUrl("localhost", config.publicPort);
    const networkUrl = formatHttpUrl(config.publicHostname, config.publicPort);
    log("");
    log("TorPlay       OK");
    log(`Port ${String(config.publicPort).padEnd(9)}OK`);
    log("mDNS          OK");
    log("");
    log(`Local:\n${localUrl}`);
    log("");
    log(`Network:\n${networkUrl}`);

    return {
      config,
      get nextProcess() { return nextProcess; },
      reporter,
      checkHealth: () => healthMonitor.checkNow(),
      stop,
    };
  } catch (error) {
    reporter.write({ state: "error", lastError: error.message });
    await stop().catch((shutdownError) => {
      console.error(shutdownError.message);
    });
    reporter.write({ state: "error", lastError: error.message });
    throw error;
  }
}

async function main() {
  let runtime;
  let control;
  let shuttingDown = false;
  const environment = loadHomeEnvironment();
  const reporter = createStatusReporter(environment.TORPLAY_STATUS_PATH, {
    logPath: environment.TORPLAY_LOG_PATH || null,
    runnerPid: Number(environment.TORPLAY_RUNNER_PID) || null,
    instanceId: environment.TORPLAY_RUNTIME_INSTANCE_ID || null,
  });
  try {
    runtime = await startHomeRuntime({ environment, statusReporter: reporter });
    control = await startControlServer({
      endpoint: controlEndpoint(environment),
      onStop: () => shutdown(0),
    });
  } catch (error) {
    reporter.write({ state: "error", lastError: error.message });
    await runtime?.stop().catch(() => {});
    reporter.write({ state: "error", lastError: error.message });
    console.error(`[TorPlay] ${error.message}`);
    process.exitCode = 1;
    return;
  }

  async function shutdown(exitCode) {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await control?.close();
      await runtime.stop();
    } catch (error) {
      console.error(`[TorPlay] ${error.message}`);
      exitCode = 1;
    }
    process.exitCode = exitCode;
  }

  process.once("SIGINT", () => void shutdown(130));
  process.once("SIGTERM", () => void shutdown(143));
  process.once("SIGHUP", () => void shutdown(129));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
