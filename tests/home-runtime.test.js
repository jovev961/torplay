import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  acquireRuntimeLock,
  formatHttpUrl,
  loadHomeEnvironment,
  parseHomeConfig,
  serverStart,
  startHomeRuntime,
} from "../scripts/home.js";
import {
  exitIfSupervisorStopped,
  supervisorIsRunning,
} from "../scripts/runtime-watchdog.js";

class FakeChild extends EventEmitter {
  constructor(autoExit) {
    super();
    this.exitCode = null;
    this.pid = 4242;
    this.signals = [];
    if (autoExit !== undefined) {
      queueMicrotask(() => {
        this.exitCode = autoExit;
        this.emit("exit", autoExit, null);
      });
    }
  }

  kill(signal) {
    this.signals.push(signal);
    queueMicrotask(() => {
      this.exitCode = 0;
      this.emit("exit", 0, signal);
    });
    return true;
  }
}

test("home configuration uses safe defaults and validates public settings", () => {
  assert.deepEqual(parseHomeConfig({}), {
    host: "127.0.0.1",
    port: 3000,
    publicHost: "0.0.0.0",
    publicPort: 80,
    publicHostname: "torplay.local",
    mdnsInterface: null,
    connectHost: "127.0.0.1",
  });
  assert.equal(formatHttpUrl("torplay.local", 80), "http://torplay.local");
  assert.equal(formatHttpUrl("torplay.local", 8080), "http://torplay.local:8080");
  assert.throws(() => parseHomeConfig({ TORPLAY_PUBLIC_PORT: "70000" }), /1 to 65535/);
  assert.throws(
    () => parseHomeConfig({ TORPLAY_PUBLIC_HOSTNAME: "example.com" }),
    /valid \.local hostname/,
  );
  assert.throws(
    () => parseHomeConfig({ TORPLAY_PORT: "80", TORPLAY_PUBLIC_PORT: "80" }),
    /must be different/,
  );
});

test("installed startup uses the standalone server with supervisor ownership", () => {
  const config = parseHomeConfig({ TORPLAY_PORT: "3456" });
  const server = serverStart({
    TORPLAY_SERVER_ENTRY: "C:\\TorPlay\\app\\server.js",
    TORPLAY_WATCHDOG_ENTRY: "C:\\TorPlay\\runtime\\runtime-watchdog.mjs",
    NODE_OPTIONS: "--trace-warnings",
  }, config);
  assert.deepEqual(server.args, ["C:\\TorPlay\\app\\server.js"]);
  assert.equal(server.environment.HOSTNAME, "127.0.0.1");
  assert.equal(server.environment.PORT, "3456");
  assert.equal(server.environment.NODE_ENV, "production");
  assert.equal(server.environment.TORPLAY_SUPERVISOR_PID, String(process.pid));
  assert.match(server.environment.NODE_OPTIONS, /^--trace-warnings --import=file:/);
  assert.match(server.environment.NODE_OPTIONS, /runtime-watchdog\.mjs$/);
});

test("the server watchdog exits only after its supervisor disappears", () => {
  const running = () => {};
  const missing = () => { throw Object.assign(new Error("missing"), { code: "ESRCH" }); };
  const denied = () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); };
  let exits = 0;

  assert.equal(supervisorIsRunning(42, running), true);
  assert.equal(supervisorIsRunning(42, denied), true);
  assert.equal(supervisorIsRunning(42, missing), false);
  assert.equal(exitIfSupervisorStopped({ supervisorPid: 42, killProcess: running, exitProcess: () => { exits += 1; } }), false);
  assert.equal(exitIfSupervisorStopped({ supervisorPid: 42, killProcess: missing, exitProcess: () => { exits += 1; } }), true);
  assert.equal(exits, 1);
});

test("installed configuration keeps process overrides and uses its explicit config file", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "torplay-home-env-"));
  const configPath = path.join(directory, "torplay.env");
  try {
    await writeFile(
      configPath,
      "TORPLAY_PORT=4000\nTMDB_API_TOKEN=from-file\nTORPLAY_DATABASE_PATH=D:\\\\custom.db\n",
    );
    const environment = loadHomeEnvironment({
      cwd: directory,
      environment: {
        TORPLAY_CONFIG_PATH: configPath,
        TORPLAY_PORT: "5000",
        TORPLAY_DEFAULT_DATABASE_PATH: "C:\\default.db",
      },
    });
    assert.equal(environment.TORPLAY_PORT, "5000");
    assert.equal(environment.TMDB_API_TOKEN, "from-file");
    assert.equal(environment.TORPLAY_DATABASE_PATH, "D:\\\\custom.db");
    assert.equal(environment.TORPLAY_EXTERNAL_CONFIG_KEYS, "");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime locks reject a live duplicate and release cleanly", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "torplay-home-lock-"));
  const lockPath = path.join(directory, "home.lock");
  try {
    const release = await acquireRuntimeLock({ lockPath, pid: 1234, killProcess: () => {} });
    await assert.rejects(
      () => acquireRuntimeLock({ lockPath, pid: 5678, killProcess: () => {} }),
      /already running/,
    );
    await release();
    const releaseAgain = await acquireRuntimeLock({
      lockPath,
      pid: 5678,
      killProcess: () => {
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      },
    });
    await releaseAgain();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Windows startup ignores obsolete managed-service settings and does not invoke Docker", async () => {
  const next = new FakeChild();
  const calls = [];
  let proxyStops = 0;
  let mdnsStops = 0;
  const runtime = await startHomeRuntime({
    platform: "win32", environment: { TORPLAY_MANAGED_JACKETT: "true" }, buildExists: () => true,
    spawnProcess: (_command, args) => {
      calls.push(args);
      if (args.includes("/T")) {
        queueMicrotask(() => { next.exitCode = 0; next.emit("exit", 0, null); });
        return new FakeChild(0);
      }
      return next;
    },
    spawnSyncProcess: () => { throw new Error("Docker must not be called"); },
    fetchProcess: async () => ({ ok: true }),
    checkPortProcess: async () => {}, acquireLockProcess: async () => async () => {},
    startProxyProcess: async () => ({ stop: async () => { proxyStops += 1; } }),
    startMdnsProcess: async () => ({ stop: async () => { mdnsStops += 1; } }),
    statusReporter: { write() {} }, log() {},
  });
  await runtime.stop();
  await runtime.stop();
  assert.equal(calls.some((args) => args.includes("compose")), false);
  assert.equal(proxyStops, 1);
  assert.equal(mdnsStops, 1);
});
