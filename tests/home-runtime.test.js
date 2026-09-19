import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  acquireRuntimeLock,
  checkDocker,
  formatHttpUrl,
  loadHomeEnvironment,
  parseHomeConfig,
  serverStart,
  startHomeRuntime,
  waitForDockerReady,
} from "../scripts/home.js";

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

test("installed startup uses the standalone server without the Next CLI", () => {
  const config = parseHomeConfig({ TORPLAY_PORT: "3456" });
  const server = serverStart({ TORPLAY_SERVER_ENTRY: "C:\\TorPlay\\app\\server.js" }, config);
  assert.deepEqual(server.args, ["C:\\TorPlay\\app\\server.js"]);
  assert.equal(server.environment.HOSTNAME, "127.0.0.1");
  assert.equal(server.environment.PORT, "3456");
  assert.equal(server.environment.NODE_ENV, "production");
});

test("Docker failures distinguish a missing client from a stopped daemon", () => {
  assert.throws(
    () => checkDocker({
      spawnSyncProcess: () => ({ status: null, error: Object.assign(new Error("missing"), { code: "ENOENT" }) }),
    }),
    /not installed or docker is not on PATH/,
  );

  let call = 0;
  assert.throws(
    () => checkDocker({
      spawnSyncProcess: () => (++call === 1 ? { status: 0 } : { status: 1, stderr: "daemon unavailable" }),
    }),
    /Docker is not running/,
  );
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

test("Docker readiness launches Desktop once and uses bounded retries", async () => {
  let checks = 0;
  let launches = 0;
  const waits = [];
  const version = await waitForDockerReady({
    dockerDesktopCommand: "Docker Desktop.exe",
    timeoutMs: 60_000,
    spawnSyncProcess: (_command, args) => {
      if (args[0] === "--version") return { status: 0, stdout: "Docker test" };
      checks += 1;
      return checks < 3 ? { status: 1 } : { status: 0, stdout: "29.0" };
    },
    spawnProcess: () => ({
      unref() { launches += 1; },
    }),
    delayProcess: async (milliseconds) => waits.push(milliseconds),
    log: () => {},
  });
  assert.equal(version, "29.0");
  assert.equal(launches, 1);
  assert.deepEqual(waits, [5_000, 10_000]);
});

test("Docker readiness does not retry a missing installation", async () => {
  let waits = 0;
  await assert.rejects(
    () => waitForDockerReady({
      timeoutMs: 60_000,
      spawnSyncProcess: () => ({
        status: null,
        error: Object.assign(new Error("missing"), { code: "ENOENT" }),
      }),
      delayProcess: async () => { waits += 1; },
    }),
    /not installed/,
  );
  assert.equal(waits, 0);
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

test("the supervisor starts in order and shuts down only services it started", async () => {
  const events = [];
  let statusCalls = 0;
  const next = new FakeChild();
  const spawnSyncProcess = (_command, args) => {
    if (args[0] === "--version") return { status: 0, stdout: "Docker version test" };
    if (args[0] === "info") return { status: 0, stdout: "29.0" };
    if (args[0] === "compose" && args[1] === "ps" && args[2] === "--status") {
      statusCalls += 1;
      return { status: 0, stdout: statusCalls === 1 ? "jackett\n" : "jackett\nflaresolverr\n" };
    }
    if (args[0] === "compose" && args[1] === "ps" && args[2] === "-q") {
      return { status: 0, stdout: `${args[3]}-id\n` };
    }
    if (args[0] === "inspect") return { status: 0, stdout: "healthy\n" };
    throw new Error(`Unexpected sync command: ${args.join(" ")}`);
  };
  const spawnProcess = (_command, args) => {
    if (args[0] === "compose" && args[1] === "up") {
      events.push("compose-up");
      return new FakeChild(0);
    }
    if (args[0] === "compose" && args[1] === "stop") {
      events.push(`compose-stop:${args.slice(2).join(",")}`);
      return new FakeChild(0);
    }
    if (args[0] === "/PID") {
      events.push("taskkill");
      queueMicrotask(() => {
        next.exitCode = 0;
        next.emit("exit", 0, null);
      });
      return new FakeChild(0);
    }
    events.push("next-start");
    return next;
  };

  const runtime = await startHomeRuntime({
    platform: "win32",
    cwd: process.cwd(),
    environment: { PATH: process.env.PATH },
    dockerCommand: "docker",
    spawnProcess,
    spawnSyncProcess,
    fetchProcess: async () => ({ ok: true }),
    buildExists: () => true,
    checkPortProcess: async (_port, host) => events.push(`port:${host}`),
    acquireLockProcess: async () => async () => events.push("lock-release"),
    configureJackettProcess: () => events.push("jackett-config"),
    startProxyProcess: async () => {
      events.push("proxy-start");
      return { stop: async () => events.push("proxy-stop") };
    },
    startMdnsProcess: async () => {
      events.push("mdns-start");
      return { stop: async () => events.push("mdns-stop") };
    },
    log: () => {},
  });

  assert.deepEqual(events.slice(0, 7), [
    "port:127.0.0.1",
    "port:0.0.0.0",
    "compose-up",
    "jackett-config",
    "next-start",
    "proxy-start",
    "mdns-start",
  ]);
  await runtime.stop();
  assert.deepEqual(events.slice(-5), [
    "mdns-stop",
    "proxy-stop",
    "taskkill",
    "compose-stop:flaresolverr",
    "lock-release",
  ]);
  assert.deepEqual(next.signals, []);
  assert.equal(events.some((event) => event === "compose-stop:jackett"), false);
});
