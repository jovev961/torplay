import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { build } from "esbuild";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import test from "node:test";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import {
  generateIcons,
  readIcoSizes,
  WINDOWS_ICON_SIZES,
} from "../scripts/generate-icons.js";
import {
  INNO_VERSION,
  NODE_VERSION,
  validateStage,
  windowsFileVersion,
} from "../scripts/release-windows.js";
import { sendControlCommand, startControlServer } from "../scripts/runtime-control.js";
import { createStatusReporter, readRuntimeStatus } from "../platform/runtime/status.js";
import { installedEnvironment, installedPaths } from "../scripts/windows-paths.js";
import {
  restartInstalledRuntime,
  runtimeOwnership,
  runtimeStatusIsActive,
  startInstalledRuntime,
  stopInstalledRuntime,
  waitForInstalledRuntime,
} from "../scripts/windows-control.js";
import { attachInstalledRuntimeLifecycle, createRotatingLog, runInstalledRuntime } from "../scripts/windows-runner.js";
import { EventEmitter, once } from "node:events";

test("Windows file versions are numeric and preserve beta build numbers", () => {
  assert.equal(windowsFileVersion("0.1.0-beta.2"), "0.1.0.2");
  assert.equal(windowsFileVersion("1.2.3"), "1.2.3.0");
  assert.throws(() => windowsFileVersion("1.2.3-rc.1"), /Unsupported/);
  assert.throws(() => windowsFileVersion("1.2.65536"), /out of range/);
});

test("canonical artwork generates matching browser and Windows icon assets", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "torplay-icons-"));
  const browserIcon = path.join(directory, "public", "torplay-favicon-v2.ico");
  const appleIcon = path.join(directory, "public", "torplay-apple-icon-v2.png");
  const windowsIcon = path.join(directory, "installer", "torplay.ico");
  const legacyIcons = [
    path.join(directory, "app", "favicon.ico"),
    path.join(directory, "app", "icon.png"),
    path.join(directory, "public", "torplay-browser-icon-v1.png"),
    path.join(directory, "public", "torplay-apple-icon-v1.png"),
  ];
  try {
    await Promise.all([
      mkdir(path.join(directory, "app"), { recursive: true }),
      mkdir(path.join(directory, "public"), { recursive: true }),
    ]);
    await Promise.all(legacyIcons.map((legacyIcon) => writeFile(legacyIcon, "old icon")));
    const result = await generateIcons({
      source: fileURLToPath(new URL("../public/torplay-logo.png", import.meta.url)),
      browserIcon,
      appleIcon,
      windowsIcon,
      legacyBrowserIcons: legacyIcons,
    });
    const [browserBytes, windowsBytes, appleMetadata, layout] = await Promise.all([
      readFile(browserIcon),
      readFile(windowsIcon),
      sharp(appleIcon).metadata(),
      readFile(new URL("../app/layout.js", import.meta.url), "utf8"),
    ]);
    assert.deepEqual(result.sizes, WINDOWS_ICON_SIZES);
    assert.deepEqual(readIcoSizes(browserBytes).sort((left, right) => left - right), WINDOWS_ICON_SIZES);
    assert.deepEqual(readIcoSizes(windowsBytes).sort((left, right) => left - right), WINDOWS_ICON_SIZES);
    assert.deepEqual(browserBytes, windowsBytes);
    assert.equal(appleMetadata.width, 180);
    assert.equal(appleMetadata.height, 180);
    assert.equal(appleMetadata.hasAlpha, true);
    for (const legacyIcon of legacyIcons) assert.equal(existsSync(legacyIcon), false);
    assert.match(layout, /url: "\/torplay-favicon-v2\.ico"/);
    assert.match(layout, /type: "image\/x-icon"/);
    assert.match(layout, /apple: \[\{ url: "\/torplay-apple-icon-v2\.png"/);
    assert.doesNotMatch(layout, /torplay-browser-icon-v1\.png/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("installed paths are writable-data based and remain configurable", () => {
  const paths = installedPaths({ installDir: "C:\\Apps\\TorPlay", dataDir: "D:\\TorPlayData" });
  const environment = installedEnvironment(paths, { TORPLAY_DATABASE_PATH: "E:\\custom.db" });
  assert.equal(environment.TORPLAY_DATABASE_PATH, "E:\\custom.db");
  assert.equal(environment.TORPLAY_DEFAULT_DATABASE_PATH, path.join("D:\\TorPlayData", "data", "torplay.db"));
  assert.equal(environment.TORPLAY_CONFIG_PATH, path.join("D:\\TorPlayData", "config", "torplay.env"));
  assert.equal(environment.TORPLAY_SERVER_ENTRY, path.join("C:\\Apps\\TorPlay", "app", "server.js"));
  assert.equal(environment.TORPLAY_WATCHDOG_ENTRY, path.join("C:\\Apps\\TorPlay", "runtime", "runtime-watchdog.mjs"));
  assert.equal(paths.trayScriptPath, path.join("C:\\Apps\\TorPlay", "runtime", "torplay-tray.ps1"));
  assert.equal(paths.trayLauncherPath, path.join("C:\\Apps\\TorPlay", "runtime", "torplay-tray.vbs"));
  assert.equal(paths.trayPidPath, path.join("D:\\TorPlayData", "runtime", "tray.pid"));
  assert.equal(paths.lockPath, path.join("D:\\TorPlayData", "runtime", "home.lock"));
  assert.equal("COMPOSE_PROJECT_NAME" in environment, false);
  assert.equal("TORPLAY_DOCKER_WAIT_SECONDS" in environment, false);
});

test("runtime status retains actionable failure details", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "torplay-status-"));
  const statusPath = path.join(directory, "runtime", "status.json");
  try {
    const reporter = createStatusReporter(statusPath);
    assert.deepEqual(Object.keys(reporter.get().components), ["TorPlay", "LAN proxy", "mDNS"]);
    reporter.write({ components: { TorPlay: "OK" } });
    reporter.write({ state: "error", lastError: "Application failed" });
    const status = readRuntimeStatus(statusPath);
    assert.equal(status.components.TorPlay, "OK");
    assert.equal(status.lastError, "Application failed");
    assert.equal(status.state, "error");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime ownership rejects stale and mismatched process records", () => {
  const status = { state: "ready", pid: 20, runnerPid: 10, instanceId: "instance" };
  assert.equal(runtimeStatusIsActive({ ...status, state: "stopped" }), false);
  assert.deepEqual(runtimeOwnership(status, {
    pid: 20, runnerPid: 10, token: "instance",
  }), { legacy: false, supervisorPid: 20, runnerPid: 10 });
  assert.equal(runtimeOwnership(status, { pid: 20, runnerPid: 10, token: "other" }), null);
  assert.deepEqual(runtimeOwnership({ state: "ready", pid: 20 }, null), {
    legacy: true, supervisorPid: 20, runnerPid: null,
  });
});

test("the control channel requests a graceful supervisor stop", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "torplay-control-"));
  const endpoint = path.join(directory, "control.sock");
  let stops = 0;
  const control = await startControlServer({ endpoint, onStop: () => { stops += 1; } });
  try {
    assert.match(await sendControlCommand({ endpoint }), /^OK stopping/);
    assert.match(await sendControlCommand({ endpoint }), /^OK stopping/);
    assert.equal(stops, 1);
  } finally {
    await control.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the control channel bounds shutdown when a client keeps its socket open", { timeout: 5_000 }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "torplay-control-drain-"));
  const endpoint = path.join(directory, "control.sock");
  const control = await startControlServer({ endpoint, closeDrainMs: 5 });
  const socket = net.createConnection(control.endpoint);
  const connectTimeout = setTimeout(() => {
    socket.destroy(new Error("Timed out connecting to the control server."));
  }, 5_000);
  try {
    await once(socket, "connect", { signal: t.signal });
    clearTimeout(connectTimeout);
    await control.close();
    if (!socket.destroyed) await once(socket, "close", { signal: t.signal });
    assert.equal(socket.destroyed, true);
    assert.equal(control.server.listening, false);
  } finally {
    clearTimeout(connectTimeout);
    socket.destroy();
    try {
      await control.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("failed control connections clean up the server and allow the endpoint to be reused", { timeout: 5_000 }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "torplay-control-failure-"));
  const endpoint = path.join(directory, "control.sock");
  let control;
  let socket;
  try {
    control = await startControlServer({ endpoint, closeDrainMs: 5 });
    socket = net.createConnection(`${control.endpoint}-missing`);
    try {
      await assert.rejects(once(socket, "connect", { signal: t.signal }));
    } finally {
      socket.destroy();
      await Promise.all([control.close(), control.close()]);
    }
    assert.equal(control.server.listening, false);
    control = await startControlServer({ endpoint });
    assert.match(await sendControlCommand({ endpoint: control.endpoint }), /^OK stopping/);
  } finally {
    socket?.destroy();
    await control?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime logs rotate at a bounded size", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "torplay-log-"));
  const logPath = path.join(directory, "torplay.log");
  try {
    const log = createRotatingLog(logPath, { maxBytes: 8, backups: 2 });
    log.write("12345678");
    log.write("abc");
    assert.equal(await readFile(`${logPath}.1`, "utf8"), "12345678");
    assert.equal(await readFile(logPath, "utf8"), "abc");
    log.write("defgh");
    log.write("z");
    assert.equal(existsSync(`${logPath}.2`), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("installed startup waits for a new healthy supervisor", async () => {
  const child = new EventEmitter();
  child.unref = () => {};
  let spawned = 0;
  let readinessOptions;
  const result = await startInstalledRuntime({
    paths: { statusPath: "status.json", launcherPath: "launcher.vbs", installDir: "C:\\TorPlay" },
    spawnProcess: () => { spawned += 1; return child; },
    readStatus: () => ({ pid: 10, startedAt: "old", state: "stopped" }),
    isRunning: () => false,
    waitForReady: async (options) => {
      readinessOptions = options;
      return { pid: 20, startedAt: "new", state: "ready" };
    },
  });
  assert.equal(spawned, 1);
  assert.equal(readinessOptions.previousStartedAt, "old");
  assert.equal(result.started, true);
  assert.equal(result.snapshot.pid, 20);
});

test("installed startup ignores a reused PID from a stopped runtime", async () => {
  const child = new EventEmitter();
  child.unref = () => {};
  let spawned = 0;
  const result = await startInstalledRuntime({
    paths: { statusPath: "status.json", launcherPath: "launcher.vbs", installDir: "C:\\TorPlay" },
    spawnProcess: () => { spawned += 1; return child; },
    readStatus: () => ({ pid: 10, startedAt: "old", state: "stopped" }),
    isRunning: () => true,
    waitForReady: async () => ({ pid: 20, startedAt: "new", state: "ready" }),
  });
  assert.equal(spawned, 1);
  assert.equal(result.started, true);
});

test("installed startup refuses an unverified active process", async () => {
  await assert.rejects(() => startInstalledRuntime({
    paths: { statusPath: "status.json", lockPath: "home.lock" },
    spawnProcess: () => assert.fail("an unverified runtime must not be duplicated"),
    readStatus: () => ({ state: "ready", pid: 20, runnerPid: 10, instanceId: "instance" }),
    readLock: () => ({ pid: 20, runnerPid: 10, token: "different" }),
    isRunning: () => true,
  }), /ownership could not be verified/);
});

test("installed startup cleans a partially orphaned runtime before launching", async () => {
  const child = new EventEmitter();
  child.unref = () => {};
  const order = [];
  const result = await startInstalledRuntime({
    paths: { statusPath: "status.json", lockPath: "home.lock", launcherPath: "launcher.vbs", installDir: "C:\\TorPlay" },
    readStatus: () => ({ state: "ready", pid: 20, runnerPid: 10, instanceId: "instance", startedAt: "old" }),
    readLock: () => ({ pid: 20, runnerPid: 10, token: "instance" }),
    isRunning: (pid) => pid === 20,
    stopRuntime: async () => { order.push("stop"); },
    spawnProcess: () => { order.push("start"); return child; },
    waitForReady: async () => ({ pid: 30, state: "ready", startedAt: "new" }),
  });
  assert.deepEqual(order, ["stop", "start"]);
  assert.equal(result.started, true);
});

test("installed startup reuses an existing healthy runtime", async () => {
  const existing = { pid: 10, startedAt: "existing", state: "ready" };
  const result = await startInstalledRuntime({
    paths: { statusPath: "status.json" },
    spawnProcess: () => { throw new Error("must not spawn"); },
    fetchProcess: async () => ({ ok: true }),
    readStatus: () => existing,
    isRunning: () => true,
  });
  assert.deepEqual(result, { started: false, snapshot: existing });
});

test("installed readiness reports startup failures and accepts healthy state", async () => {
  const states = [
    { pid: 20, startedAt: "new", state: "starting" },
    { pid: 20, startedAt: "new", state: "ready" },
  ];
  const snapshot = await waitForInstalledRuntime({
    paths: { statusPath: "status.json" },
    previousStartedAt: "old",
    readStatus: () => states.shift() || states.at(-1),
    isRunning: () => true,
    fetchProcess: async () => ({ ok: true }),
    waitProcess: async () => {},
    now: (() => { let value = 0; return () => value += 10; })(),
    timeoutMs: 100,
  });
  assert.equal(snapshot.state, "ready");

  await assert.rejects(
    () => waitForInstalledRuntime({
      paths: { statusPath: "status.json" },
      previousStartedAt: "old",
      readStatus: () => ({ pid: 30, startedAt: "failed", state: "error", lastError: "Port unavailable" }),
      waitProcess: async () => {},
    }),
    /Port unavailable/,
  );
});

test("installed stop is idempotent and restart finishes stop before start", async () => {
  assert.deepEqual(await stopInstalledRuntime({
    paths: { statusPath: "status.json" },
    readStatus: () => null,
    isRunning: () => false,
  }), { stopped: false, forced: false });

  let runningChecks = 0;
  let controlRequests = 0;
  assert.deepEqual(await stopInstalledRuntime({
    paths: { statusPath: "status.json", dataDir: "C:\\TorPlayData" },
    readStatus: () => ({ pid: 42 }),
    isRunning: () => runningChecks++ < 2,
    sendControl: async () => { controlRequests += 1; },
    waitProcess: async () => {},
  }), { stopped: true, forced: false });
  assert.equal(controlRequests, 1);

  const order = [];
  await restartInstalledRuntime({
    stopRuntime: async () => { order.push("stop"); },
    startRuntime: async () => { order.push("start"); },
  });
  assert.deepEqual(order, ["stop", "start"]);
});

test("installed stop force-kills the validated runner process tree", async () => {
  const running = new Set([10, 20]);
  let invocation;
  const result = await stopInstalledRuntime({
    paths: { statusPath: "status.json", lockPath: "home.lock" },
    readStatus: () => ({ state: "ready", pid: 20, runnerPid: 10, instanceId: "instance" }),
    readLock: () => ({ pid: 20, runnerPid: 10, token: "instance" }),
    isRunning: (pid) => running.has(pid),
    sendControl: async () => { throw new Error("pipe unavailable"); },
    spawnSyncProcess: (command, args) => {
      invocation = [command, args];
      running.clear();
      return { status: 0 };
    },
    waitProcess: async () => {},
  });
  assert.deepEqual(invocation, ["taskkill.exe", ["/PID", "10", "/T", "/F"]]);
  assert.deepEqual(result, { stopped: true, forced: true });
});

test("installed stop targets an orphaned supervisor when its runner is already gone", async () => {
  const running = new Set([20]);
  let targetPid;
  const result = await stopInstalledRuntime({
    paths: { statusPath: "status.json", lockPath: "home.lock" },
    readStatus: () => ({ state: "ready", pid: 20, runnerPid: 10, instanceId: "instance" }),
    readLock: () => ({ pid: 20, runnerPid: 10, token: "instance" }),
    isRunning: (pid) => running.has(pid),
    sendControl: async () => { throw new Error("pipe unavailable"); },
    spawnSyncProcess: (_command, args) => {
      targetPid = args[1];
      running.clear();
      return { status: 0 };
    },
    waitProcess: async () => {},
  });
  assert.equal(targetPid, "20");
  assert.deepEqual(result, { stopped: true, forced: true });
});

test("installed stop waits for both supervisor and runner to exit", async () => {
  const running = new Set([10, 20]);
  let waits = 0;
  const result = await stopInstalledRuntime({
    paths: { statusPath: "status.json", lockPath: "home.lock" },
    readStatus: () => ({ state: "ready", pid: 20, runnerPid: 10, instanceId: "instance" }),
    readLock: () => ({ pid: 20, runnerPid: 10, token: "instance" }),
    isRunning: (pid) => running.has(pid),
    sendControl: async () => {},
    waitProcess: async () => {
      waits += 1;
      if (waits === 1) running.delete(20);
      if (waits === 2) running.delete(10);
    },
    spawnSyncProcess: () => assert.fail("graceful stop must not force termination"),
  });
  assert.deepEqual(result, { stopped: true, forced: false });
  assert.equal(waits, 2);
});

test("installed stop never kills an unverified or stopped PID", async () => {
  let kills = 0;
  const dependencies = {
    paths: { statusPath: "status.json", lockPath: "home.lock" },
    isRunning: () => true,
    sendControl: async () => { throw new Error("pipe unavailable"); },
    spawnSyncProcess: () => { kills += 1; return { status: 0 }; },
    waitProcess: async () => {},
  };
  assert.deepEqual(await stopInstalledRuntime({
    ...dependencies,
    readStatus: () => ({ state: "stopped", pid: 20 }),
  }), { stopped: false, forced: false });
  await assert.rejects(() => stopInstalledRuntime({
    ...dependencies,
    readStatus: () => ({ state: "ready", pid: 20, runnerPid: 10, instanceId: "instance" }),
    readLock: () => ({ pid: 20, runnerPid: 10, token: "different" }),
  }), /ownership could not be verified/);
  assert.equal(kills, 0);
});

test("the Windows runner forwards termination once and detaches after exit", async () => {
  const processRef = new EventEmitter();
  processRef.exitCode = 0;
  const child = new EventEmitter();
  child.exitCode = null;
  let kills = 0;
  child.kill = () => { kills += 1; };
  let stops = 0;
  attachInstalledRuntimeLifecycle(child, {
    paths: {}, environment: {}, processRef,
    stopRuntime: async () => { stops += 1; return { stopped: true }; },
  });
  processRef.emit("SIGTERM");
  processRef.emit("SIGINT");
  await Promise.resolve();
  assert.equal(stops, 1);
  assert.equal(kills, 0);
  child.emit("exit", 0, null);
  assert.equal(processRef.listenerCount("SIGHUP"), 0);
});

test("the Windows runner identifies its process tree and exits with its supervisor", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "torplay-runner-"));
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  const processRef = new EventEmitter();
  processRef.pid = 10;
  let exitCode = null;
  processRef.exit = (code) => { exitCode = code; };
  processRef.exitCode = 0;
  try {
    let childEnvironment;
    runInstalledRuntime({
      paths: {
        installDir: directory,
        dataDir: directory,
        logPath: path.join(directory, "torplay.log"),
        nodePath: "node.exe",
        homeEntry: "home.mjs",
      },
      processRef,
      createInstanceId: () => "instance",
      spawnProcess: (_command, _args, options) => {
        childEnvironment = options.env;
        return child;
      },
    });
    assert.equal(childEnvironment.TORPLAY_RUNNER_PID, "10");
    assert.equal(childEnvironment.TORPLAY_RUNTIME_INSTANCE_ID, "instance");
    child.exitCode = 0;
    child.emit("exit", 0, null);
    assert.equal(exitCode, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the bundled runner stays alive until its supervisor exits across repeated starts", async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "torplay-bundled-runner-")));
  const paths = installedPaths({ installDir: directory, dataDir: path.join(directory, "data") });
  try {
    await mkdir(path.dirname(paths.runnerEntry), { recursive: true });
    await copyFile(process.execPath, paths.nodePath);
    await writeFile(paths.homeEntry, 'setTimeout(() => process.exit(7), 2500);\n');
    await build({
      entryPoints: [fileURLToPath(new URL("../scripts/windows-runner.js", import.meta.url))],
      outfile: paths.runnerEntry,
      bundle: true, platform: "node", format: "esm", target: "node24",
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const child = spawn(process.execPath, [paths.runnerEntry], {
        env: { ...process.env, TORPLAY_INSTALL_DIR: directory, TORPLAY_DATA_DIR: paths.dataDir },
        stdio: "ignore",
      });
      const timeout = setTimeout(() => child.kill(), 10_000);
      try {
        const [code, signal] = await once(child, "exit");
        assert.equal(signal, null);
        assert.equal(code, 7, `the runner must exit with its supervisor, not an imported CLI:\n${await readFile(paths.logPath, "utf8")}`);
      } finally {
        clearTimeout(timeout);
        if (child.exitCode === null && child.signalCode === null) child.kill();
      }
    }
    const log = await readFile(paths.logPath, "utf8");
    assert.equal(log.match(/TorPlay exited with code 7/g)?.length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("release validation requires the packaged runtime and Windows native tools", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "torplay-stage-"));
  try {
    const files = [
      "runtime/node.exe",
      "runtime/home.mjs",
      "runtime/runtime-watchdog.mjs",
      "runtime/windows-runner.mjs",
      "runtime/windows-control.mjs",
      "runtime/torplay-first-launch.vbs",
      "runtime/torplay-tray.ps1",
      "runtime/torplay-tray.vbs",
      "runtime/torplay.ico",
      "app/server.js",
      "app/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
      "app/node_modules/ffmpeg-static/ffmpeg.exe",
      "app/node_modules/ffprobe-static/ffprobe.exe",
    ];
    for (const file of files) {
      const filePath = path.join(directory, file);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, "test");
    }
    assert.doesNotThrow(() => validateStage(directory));
    await rm(path.join(directory, "app", "node_modules", "ffmpeg-static", "ffmpeg.exe"));
    assert.throws(() => validateStage(directory), /ffmpeg\.exe/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Windows packaging has no Docker runtime dependency", async () => {
  const releaseScript = await readFile(new URL("../scripts/release-windows.js", import.meta.url), "utf8");
  assert.doesNotMatch(releaseScript, /docker|compose/i);
  assert.equal(existsSync(new URL("../docker-compose.yml", import.meta.url)), false);
});

test("installer declares durable data, login startup, shortcuts, and firewall cleanup", async () => {
  const installer = await readFile(new URL("../installer/windows/torplay.iss", import.meta.url), "utf8");
  const firstLaunch = await readFile(
    new URL("../installer/windows/torplay-first-launch.vbs", import.meta.url),
    "utf8",
  );
  const launcher = await readFile(
    new URL("../installer/windows/torplay-launcher.vbs", import.meta.url),
    "utf8",
  );
  const iconsSection = installer.match(/\[Icons\]\s+([\s\S]*?)(?=\n\[)/)?.[1] || "";
  assert.match(installer, /PrivilegesRequired=lowest/);
  assert.match(installer, /Software\\Microsoft\\Windows\\CurrentVersion\\Run/);
  assert.match(installer, /ValueData: """\{sys\}\\wscript\.exe"" ""\{app\}\\runtime\\torplay-tray\.vbs"""/);
  assert.match(installer, /SetupIconFile=torplay\.ico/);
  assert.match(installer, /UninstallDisplayIcon=\{app\}\\runtime\\torplay\.ico/);
  assert.match(installer, /Name: "desktopicon";[^\n]+Flags: unchecked/);
  assert.match(iconsSection, /Name: "\{group\}\\TorPlay";[^\n]+torplay-launcher\.vbs[^\n]+IconFilename: "\{app\}\\runtime\\torplay\.ico"/);
  assert.match(iconsSection, /Name: "\{userdesktop\}\\TorPlay";[^\n]+Tasks: desktopicon/);
  assert.doesNotMatch(iconsSection, /Open TorPlay|TorPlay Tray|TorPlay Status|Start or Restart TorPlay|Stop TorPlay/);
  for (const obsoleteShortcut of [
    "Open TorPlay.url",
    "TorPlay Tray.lnk",
    "TorPlay Status.lnk",
    "Start or Restart TorPlay.lnk",
    "Stop TorPlay.lnk",
  ]) {
    assert.ok(installer.includes(`Name: "{group}\\${obsoleteShortcut}"`));
  }
  assert.match(installer, /windows-firewall\.ps1"" -Remove/);
  assert.match(installer, /torplay-tray\.ps1"" -StopExisting/);
  assert.match(installer, /uninsneveruninstall/);
  assert.match(installer, /VersionInfoVersion=\{#VersionInfoVersion\}/);
  assert.match(installer, /torplay-first-launch\.vbs/);
  assert.match(installer, /waituntilterminated skipifsilent/);
  assert.doesNotMatch(installer, /docker compose down/);
  assert.match(firstLaunch, /windows-control\.mjs"\) & " start"/);
  assert.match(firstLaunch, /shell\.Run\(controlCommand, 0, True\)/);
  assert.match(firstLaunch, /torplay-tray\.vbs/);
  assert.match(firstLaunch, /If exitCode = 0 Then/);
  assert.match(firstLaunch, /http:\/\/localhost\/setup/);
  assert.ok(firstLaunch.indexOf("windows-control.mjs") < firstLaunch.indexOf("torplay-tray.vbs"));
  assert.ok(firstLaunch.indexOf("torplay-tray.vbs") < firstLaunch.indexOf("http://localhost/setup"));
  assert.match(launcher, /If verb = "start" Then/);
  assert.match(launcher, /windows-runner\.mjs/);
  assert.match(launcher, /windows-control\.mjs/);
  assert.match(launcher, /exitCode = shell\.Run\(command, 0, True\)/);
  assert.match(launcher, /torplay-tray\.vbs/);
  assert.match(launcher, /If exitCode = 0 Then/);
  assert.match(launcher, /http:\/\/localhost/);
  assert.ok(launcher.indexOf("exitCode = shell.Run") < launcher.indexOf("http://localhost"));
});

test("Windows tray controls the existing runtime without starting a second backend", async () => {
  const tray = await readFile(new URL("../installer/windows/torplay-tray.ps1", import.meta.url), "utf8");
  const launcher = await readFile(new URL("../installer/windows/torplay-tray.vbs", import.meta.url), "utf8");
  const releaseScript = await readFile(new URL("../scripts/release-windows.js", import.meta.url), "utf8");

  assert.match(tray, /Windows\.Forms\.NotifyIcon/);
  assert.match(tray, /Status: Running/);
  assert.match(tray, /Status: Recovering/);
  assert.match(tray, /Status: Error/);
  assert.match(tray, /Retry TorPlay/);
  assert.match(tray, /Open TorPlay/);
  assert.match(tray, /Open Logs/);
  assert.match(tray, /Restart TorPlay/);
  assert.match(tray, /Stop TorPlay/);
  assert.match(tray, /Start with Windows/);
  assert.match(tray, /windows-control\.mjs/);
  assert.match(tray, /CurrentVersion\\Run/);
  assert.match(tray, /torplay\.ico/);
  assert.match(tray, /\[Drawing\.Icon\]::new\(\$iconPath, 32, 32\)/);
  assert.doesNotMatch(tray, /TorPlayNativeIcon|FillEllipse|FillPolygon/);
  assert.match(tray, /Local\\TorPlayTray/);
  assert.match(tray, /Stop-TorPlayAndExit/);
  assert.match(tray, /Start-TorPlayControl "stop"/);
  assert.match(tray, /Windows\.Forms\.Timer/);
  assert.match(tray, /controlProcess\.HasExited/);
  assert.match(tray, /controlDeadline/);
  assert.doesNotMatch(tray, /Start-Process[^\n]+-Wait/);
  assert.match(tray, /SystemEvents\]::add_SessionEnding/);
  assert.doesNotMatch(tray, /next start|server\.js|WebTorrent/);
  assert.match(launcher, /torplay-tray\.ps1/);
  assert.match(releaseScript, /installer\/windows\/torplay-tray\.ps1/);
  assert.match(releaseScript, /installer\/windows\/torplay-tray\.vbs/);
  assert.match(releaseScript, /installer\/windows\/torplay\.ico/);
  assert.match(releaseScript, /runtime-watchdog\.js/);
});

test("fresh Windows configuration leaves required provider credentials for browser setup", async () => {
  const template = await readFile(new URL("../installer/windows/torplay.env", import.meta.url), "utf8");
  assert.doesNotMatch(template, /^TMDB_API_TOKEN=/m);
  assert.doesNotMatch(template, /^JACKETT_API_KEY=/m);
  assert.match(template, /^JACKETT_MOVIE_INDEXERS=$/m);
  assert.match(template, /^JACKETT_SHOW_INDEXERS=$/m);
  assert.doesNotMatch(template, /TORPLAY_(?:CONFIGURED_)?NATIVE_PROVIDERS/);
  assert.doesNotMatch(template, /DOCKER|COMPOSE|TORPLAY_MANAGED_JACKETT/i);
});

test("Windows installer workflow pins its toolchain and publishes verified artifacts", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/windows-installer.yml", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(workflow, /\b(pull_request|push):/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /permissions:\s*\n\s*contents: read/);
  assert.match(workflow, /runs-on: windows-2025/);
  assert.match(workflow, new RegExp(`node-version: "${NODE_VERSION.replaceAll(".", "\\.")}"`));
  assert.match(workflow, new RegExp(`INNO_SETUP_VERSION: "${INNO_VERSION.replaceAll(".", "\\.")}"`));
  assert.match(workflow, /INNO_SETUP_SHA256: "[a-f0-9]{64}"/);
  assert.match(workflow, /releases\/download\/is-7_1_0\/innosetup-\$env:INNO_SETUP_VERSION-x64\.exe/);
  assert.match(workflow, /GITHUB_REF_NAME -ne "v\$version"/);
  assert.match(workflow, /actions\/checkout@[a-f0-9]{40} # v6/);
  assert.match(workflow, /actions\/setup-node@[a-f0-9]{40} # v7/);
  assert.match(workflow, /actions\/upload-artifact@[a-f0-9]{40} # v7/);
  assert.match(workflow, /run: npm ci/);
  assert.match(workflow, /run: npm run release:windows/);
  assert.match(workflow, /Get-FileHash[^\n]+SHA256/);
  assert.match(workflow, /TorPlay-Setup-\$\{\{ steps\.package\.outputs\.version \}\}\.exe/);
  assert.match(workflow, /TorPlay-Setup-\$\{\{ steps\.package\.outputs\.version \}\}\.exe\.sha256/);
  assert.match(workflow, /if-no-files-found: error/);
  assert.match(workflow, /retention-days: 14/);
  assert.doesNotMatch(workflow, /contents: write|gh release|softprops\/action-gh-release/i);
});
