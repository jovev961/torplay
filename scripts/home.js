import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { configureJackett, readLocalEnvironment } from "./jackett-config.js";
import { resolveDockerCommand, resolveDockerDesktopCommand } from "./docker-paths.js";
import { startMdnsAdvertisement, startReverseProxy } from "./home-network.js";
import { controlEndpoint, startControlServer } from "./runtime-control.js";
import { createStatusReporter } from "./runtime-status.js";
import { SETTINGS_ENVIRONMENT_KEYS } from "../lib/settings/definitions.js";

const require = createRequire(import.meta.url);
const REQUIRED_SERVICES = ["jackett"];
const COMPOSE_START_ARGS = [
  "compose",
  "up",
  "-d",
  "--wait",
  "--wait-timeout",
  "120",
  ...REQUIRED_SERVICES,
];

function withCode(message, code) {
  return Object.assign(new Error(message), { code });
}

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
  return serverEntry
    ? {
        entry: serverEntry,
        args: [serverEntry],
        environment: { ...environment, NODE_ENV: "production", HOSTNAME: config.host, PORT: String(config.port) },
      }
    : {
        entry: path.join(process.cwd(), ".next", "BUILD_ID"),
        args: [require.resolve("next/dist/bin/next"), "start", "-H", config.host, "-p", String(config.port)],
        environment: { ...environment, NODE_ENV: "production" },
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
  killProcess = process.kill,
} = {}) {
  await mkdir(path.dirname(lockPath), { recursive: true });
  const token = randomUUID();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(JSON.stringify({ pid, token, startedAt: new Date().toISOString() }));
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

function successfulResult(result, label) {
  if (result.error) throw new Error(`${label} could not run: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = result.stderr?.trim();
    throw new Error(`${label} failed${detail ? `: ${detail}` : ` with exit code ${result.status}`}.`);
  }
  return result.stdout?.trim() || "";
}

function dockerOptions(environment) {
  return {
    encoding: "utf8",
    env: environment,
    timeout: 30_000,
    windowsHide: true,
  };
}

export function checkDocker({
  dockerCommand = "docker",
  spawnSyncProcess = spawnSync,
  environment = process.env,
} = {}) {
  const installed = spawnSyncProcess(dockerCommand, ["--version"], dockerOptions(environment));
  if (installed.error?.code === "ENOENT" || installed.status !== 0) {
    throw withCode(
      "TorPlay could not start because Docker Desktop is not installed or docker is not on PATH.",
      "DOCKER_NOT_FOUND",
    );
  }

  const daemon = spawnSyncProcess(
    dockerCommand,
    ["info", "--format", "{{.ServerVersion}}"],
    dockerOptions(environment),
  );
  if (daemon.error || daemon.status !== 0) {
    throw withCode(
      "TorPlay could not start because Docker is not running. Start Docker Desktop and try again.",
      "DOCKER_NOT_READY",
    );
  }
  return daemon.stdout?.trim() || "available";
}

function dockerRetryDelays(timeoutMs) {
  const delays = [];
  let elapsed = 0;
  for (const delayMs of [5_000, 10_000, 20_000]) {
    if (elapsed + delayMs > timeoutMs) return delays;
    delays.push(delayMs);
    elapsed += delayMs;
  }
  while (elapsed + 30_000 <= timeoutMs) {
    delays.push(30_000);
    elapsed += 30_000;
  }
  if (elapsed < timeoutMs) delays.push(timeoutMs - elapsed);
  return delays;
}

export async function waitForDockerReady({
  dockerCommand = "docker",
  spawnSyncProcess = spawnSync,
  spawnProcess = spawn,
  environment = process.env,
  timeoutMs = 0,
  dockerDesktopCommand = null,
  delayProcess = delay,
  log = console.log,
} = {}) {
  let desktopStarted = false;
  const delays = dockerRetryDelays(timeoutMs);
  for (let attempt = 0; ; attempt += 1) {
    try {
      return checkDocker({ dockerCommand, spawnSyncProcess, environment });
    } catch (error) {
      if (error.code === "DOCKER_NOT_FOUND" || attempt >= delays.length) throw error;
      if (!desktopStarted && dockerDesktopCommand) {
        desktopStarted = true;
        const desktop = spawnProcess(dockerDesktopCommand, [], {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        });
        desktop.on?.("error", (desktopError) => {
          log(`[TorPlay] Docker Desktop could not be launched: ${desktopError.message}`);
        });
        desktop.unref?.();
        log("[TorPlay] Docker Desktop is starting.");
      }
      const waitMs = delays[attempt];
      log(`[TorPlay] Docker is not ready; retrying in ${Math.ceil(waitMs / 1_000)} seconds.`);
      await delayProcess(waitMs);
    }
  }
}

export function runningComposeServices({
  dockerCommand,
  spawnSyncProcess = spawnSync,
  environment,
} = {}) {
  const result = spawnSyncProcess(
    dockerCommand,
    ["compose", "ps", "--status", "running", "--services"],
    dockerOptions(environment),
  );
  const output = successfulResult(result, "Docker Compose status");
  return new Set(output.split(/\r?\n/).map((value) => value.trim()).filter(Boolean));
}

export function composeServiceHealth(service, {
  dockerCommand,
  spawnSyncProcess = spawnSync,
  environment,
} = {}) {
  const idResult = spawnSyncProcess(
    dockerCommand,
    ["compose", "ps", "-q", service],
    dockerOptions(environment),
  );
  const containerId = successfulResult(idResult, `${service} container lookup`);
  if (!containerId) throw new Error(`${service} did not start.`);

  const healthResult = spawnSyncProcess(
    dockerCommand,
    [
      "inspect",
      "--format",
      "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}",
      containerId,
    ],
    dockerOptions(environment),
  );
  return successfulResult(healthResult, `${service} health check`).toLowerCase();
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

async function stopComposeServices(services, {
  dockerCommand,
  spawnProcess,
  environment,
} = {}) {
  if (!services.length) return;
  await runCommand(
    spawnProcess,
    dockerCommand,
    ["compose", "stop", ...services],
    { stdio: "inherit", env: environment, windowsHide: true },
    "Docker services shutdown",
  );
}

export async function startHomeRuntime({
  platform = process.platform,
  cwd = process.cwd(),
  environment,
  spawnProcess = spawn,
  spawnSyncProcess = spawnSync,
  fetchProcess = fetch,
  configureJackettProcess = configureJackett,
  startProxyProcess = startReverseProxy,
  startMdnsProcess = startMdnsAdvertisement,
  acquireLockProcess = acquireRuntimeLock,
  checkPortProcess = checkPortAvailable,
  buildExists = existsSync,
  dockerCommand,
  dockerDesktopCommand,
  waitForDockerProcess = waitForDockerReady,
  delayProcess = delay,
  statusReporter,
  log = console.log,
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
  const releaseLock = await acquireLockProcess({ lockPath: path.join(runtimeDir, "home.lock") });
  dockerCommand ||= resolveDockerCommand({ platform, environment });
  dockerDesktopCommand ??= resolveDockerDesktopCommand({ platform, environment });
  let nextProcess = null;
  let proxy = null;
  let mdns = null;
  let newlyStartedServices = [];
  let stopped = false;

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    log("[TorPlay] Shutting down...");
    const errors = [];
    if (mdns) await mdns.stop().catch((error) => errors.push(error));
    if (proxy) await proxy.stop().catch((error) => errors.push(error));
    await stopNextProcess(nextProcess, { platform, spawnProcess, environment })
      .catch((error) => errors.push(error));
    await stopComposeServices([...newlyStartedServices].reverse(), {
      dockerCommand,
      spawnProcess,
      environment,
    }).catch((error) => errors.push(error));
    await releaseLock().catch((error) => errors.push(error));
    reporter.write({
      state: "stopped",
      components: { TorPlay: "STOPPED", "mDNS": "STOPPED" },
    });
    log("[TorPlay] Shutdown complete.");
    if (errors.length) throw new AggregateError(errors, "TorPlay shutdown encountered errors.");
  };

  try {
    reporter.write({ state: "starting", lastError: null });
    log("[TorPlay] Starting Windows home runtime...");
    await checkPortProcess(config.port, config.host);
    await checkPortProcess(config.publicPort, config.publicHost);

    if (environment.TORPLAY_MANAGED_JACKETT === "true") {
      const waitSeconds = Number(environment.TORPLAY_DOCKER_WAIT_SECONDS || 0);
      const dockerVersion = await waitForDockerProcess({
        dockerCommand,
        spawnSyncProcess,
        spawnProcess,
        environment,
        timeoutMs: Number.isFinite(waitSeconds) && waitSeconds > 0 ? waitSeconds * 1_000 : 0,
        dockerDesktopCommand,
        delayProcess,
        log,
      });
      reporter.write({ components: { Docker: "OK" } });
      log(`[TorPlay] Docker OK (${dockerVersion}).`);
      const runningBefore = runningComposeServices({ dockerCommand, spawnSyncProcess, environment });

      try {
        await runCommand(
          spawnProcess,
          dockerCommand,
          COMPOSE_START_ARGS,
          { stdio: "inherit", env: environment, windowsHide: true },
          "Docker services",
        );
      } finally {
        try {
          const runningAfter = runningComposeServices({ dockerCommand, spawnSyncProcess, environment });
          newlyStartedServices = REQUIRED_SERVICES.filter(
            (service) => runningAfter.has(service) && !runningBefore.has(service),
          );
        } catch {
          newlyStartedServices = REQUIRED_SERVICES.filter((service) => !runningBefore.has(service));
        }
      }

      configureJackettProcess({
        dockerCommand,
        spawnSyncProcess,
        environment,
        processEnvironment: environment,
      });
      for (const service of REQUIRED_SERVICES) {
        const health = composeServiceHealth(service, { dockerCommand, spawnSyncProcess, environment });
        if (health !== "healthy" && health !== "running") {
          throw new Error(`${service} is ${health || "not healthy"}.`);
        }
        reporter.write({ components: { Jackett: "OK" } });
        log("[TorPlay] Jackett ready.");
      }

    } else {
      reporter.write({ components: { Docker: "DISABLED", Jackett: "DISABLED" } });
    }

    const server = serverStart(environment, config);
    nextProcess = spawnProcess(
      process.execPath,
      server.args,
      {
        cwd,
        env: server.environment,
        stdio: "inherit",
        windowsHide: true,
      },
    );
    let nextFailure = null;
    nextProcess.on("error", (error) => {
      nextFailure = new Error(`TorPlay could not start: ${error.message}`);
    });
    nextProcess.on("exit", (code, signal) => {
      if (!stopped) {
        nextFailure = new Error(
          `TorPlay stopped during startup${signal ? ` with ${signal}` : ` (exit ${code})`}.`,
        );
      }
    });
    const requireNextRunning = () => {
      if (nextFailure) throw nextFailure;
    };
    await waitForHttp(`${formatHttpUrl(config.connectHost, config.port)}/api/health`, {
      fetchProcess,
      child: nextProcess,
    });
    requireNextRunning();
    reporter.write({ components: { TorPlay: "OK" } });
    log("[TorPlay] Application ready.");

    proxy = await startProxyProcess({
      targetHost: config.connectHost,
      targetPort: config.port,
      publicHost: config.publicHost,
      publicPort: config.publicPort,
    });
    await waitForHttp(`${formatHttpUrl("127.0.0.1", config.publicPort)}/api/health`, { fetchProcess });
    requireNextRunning();
    log(`[TorPlay] Port ${config.publicPort} frontend ready.`);

    mdns = await startMdnsProcess({
      hostname: config.publicHostname,
      port: config.publicPort,
      mdnsInterface: config.mdnsInterface,
    });
    requireNextRunning();
    reporter.write({ components: { "mDNS": "OK" }, state: "ready" });
    log(`[TorPlay] mDNS registered ${config.publicHostname}.`);

    const localUrl = formatHttpUrl("localhost", config.publicPort);
    const networkUrl = formatHttpUrl(config.publicHostname, config.publicPort);
    log("");
    log("TorPlay       OK");
    if (environment.TORPLAY_MANAGED_JACKETT === "true") {
      log("Jackett       OK");
    }
    log(`Port ${String(config.publicPort).padEnd(9)}OK`);
    log("mDNS          OK");
    log("");
    log(`Local:\n${localUrl}`);
    log("");
    log(`Network:\n${networkUrl}`);

    return { config, nextProcess, reporter, stop };
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
  runtime.nextProcess.once("error", (error) => {
    reporter.write({ state: "error", lastError: `Application process failed: ${error.message}` });
    console.error(`[TorPlay] Application process failed: ${error.message}`);
    void shutdown(1);
  });
  runtime.nextProcess.once("exit", (code, signal) => {
    if (shuttingDown) return;
    const message = `Application stopped unexpectedly${signal ? ` with ${signal}` : ` (exit ${code})`}.`;
    reporter.write({ state: "error", lastError: message });
    console.error(
      `[TorPlay] ${message}`,
    );
    void shutdown(1);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
