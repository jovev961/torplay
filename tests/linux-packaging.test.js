import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { linuxPaths, linuxRuntimeEnvironment } from "../scripts/linux-paths.js";
import { isLinuxX64Elf, validateLinuxStage } from "../scripts/release-linux.js";
import { networkAccessDetails } from "../lib/network/access.js";
import { startLinuxApp } from "../scripts/linux-launcher.js";
import { sendControlCommand } from "../scripts/runtime-control.js";

function temporaryDirectory(callback) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "torplay-linux-test-"));
  try { return callback(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}

function elf() {
  const bytes = Buffer.alloc(20);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(bytes);
  bytes.writeUInt16LE(62, 18);
  return bytes;
}

test("Linux paths use XDG storage and force a loopback runtime", () => temporaryDirectory((directory) => {
  const paths = linuxPaths({
    XDG_CONFIG_HOME: path.join(directory, "config"),
    XDG_DATA_HOME: path.join(directory, "data"),
    XDG_CACHE_HOME: path.join(directory, "cache"),
    XDG_STATE_HOME: path.join(directory, "state"),
    XDG_RUNTIME_DIR: path.join(directory, "run"),
  });
  assert.equal(paths.configPath, path.join(directory, "config/torplay/torplay.env"));
  assert.equal(paths.databasePath, path.join(directory, "data/torplay/torplay.db"));
  assert.equal(paths.controlPath, path.join(directory, "run/torplay/control.sock"));
  const environment = linuxRuntimeEnvironment(paths, { TORPLAY_HOST: "0.0.0.0" });
  assert.equal(environment.TORPLAY_HOST, "127.0.0.1");
  assert.equal(environment.TORPLAY_DISTRIBUTION, "linux-appimage");
}));

test("Linux AppImage packaging runs only when manually requested", () => {
  const workflow = readFileSync(path.resolve(".github/workflows/linux-appimage.yml"), "utf8");
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /\b(pull_request|push):/);
  assert.match(workflow, /runs-on: ubuntu-24\.04/);
});

test("Linux stage rejects absent files, wrong native architecture, and secrets", () => temporaryDirectory((directory) => {
  const required = [
    "AppRun", "torplay.desktop", "torplay.png", ".DirIcon", "usr/bin/node",
    "usr/lib/torplay/app/server.js", "usr/lib/torplay/runtime/linux-launcher.mjs",
    "usr/lib/torplay/runtime/runtime-watchdog.mjs", "usr/lib/torplay/app/better_sqlite3.node",
    "usr/lib/torplay/app/ffmpeg", "usr/lib/torplay/app/ffprobe",
  ];
  assert.throws(() => validateLinuxStage(directory), /missing AppRun/);
  for (const item of required) {
    const filename = path.join(directory, item);
    mkdirSync(path.dirname(filename), { recursive: true });
    writeFileSync(filename, /(?:node|ffmpeg|ffprobe)$/.test(item) ? elf() : "fixture");
  }
  validateLinuxStage(directory);
  assert.equal(isLinuxX64Elf(path.join(directory, "usr/bin/node")), true);
  writeFileSync(path.join(directory, "usr/lib/torplay/app/.env.local"), "SECRET=fixture");
  assert.throws(() => validateLinuxStage(directory), /must not contain/);
  rmSync(path.join(directory, "usr/lib/torplay/app/.env.local"));
  writeFileSync(path.join(directory, "usr/lib/torplay/app/ffmpeg"), "wrong architecture");
  assert.throws(() => validateLinuxStage(directory), /ffmpeg/);
  assert.equal(readFileSync(path.join(directory, "AppRun"), "utf8"), "fixture");
}));

test("Linux network details never advertise a LAN address", () => {
  const request = new Request("http://127.0.0.1:39123/api/network-access");
  const details = networkAccessDetails(request, {
    environment: { TORPLAY_DISTRIBUTION: "linux-appimage", PORT: "39123" },
    interfaces: { eth0: [{ family: "IPv4", address: "192.168.1.22", internal: false }] },
  });
  assert.deepEqual(details, {
    scope: "desktop", hostnameUrl: "http://127.0.0.1:39123", lanAddress: null, lanUrl: null,
  });
});

test("Linux supervisor starts a loopback server and Quit cleans up its child and socket", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "torplay-linux-runtime-"));
  const app = path.join(directory, "app");
  mkdirSync(app);
  const server = path.join(app, "server.js");
  writeFileSync(server, `const http = require("node:http");
    const server = http.createServer((req, res) => {
      res.writeHead(req.url === "/api/health" ? 200 : 404); res.end();
    });
    server.listen(Number(process.env.PORT), process.env.HOSTNAME);
    process.on("SIGTERM", () => server.close());`);
  const paths = linuxPaths({
    XDG_CONFIG_HOME: path.join(directory, "config"),
    XDG_DATA_HOME: path.join(directory, "data"),
    XDG_CACHE_HOME: path.join(directory, "cache"),
    XDG_STATE_HOME: path.join(directory, "state"),
    XDG_RUNTIME_DIR: path.join(directory, "run"),
  });
  let browserUrl;
  let runtime;
  try {
    runtime = await startLinuxApp({
      paths, environment: {}, serverEntry: server,
      watchdogEntry: path.resolve("scripts/runtime-watchdog.js"),
      openBrowser: async (url) => { browserUrl = url; return true; },
    });
    assert.equal(browserUrl, runtime.url);
    assert.equal((await fetch(`${runtime.url}/api/health`)).status, 200);
    assert.equal(existsSync(paths.controlPath), true);
    await sendControlCommand({ endpoint: paths.controlPath });
    await new Promise((resolve) => runtime.child.once("exit", resolve));
    await runtime.stop();
    assert.equal(existsSync(paths.lockPath), false);
    assert.equal(existsSync(paths.controlPath), false);
  } finally {
    await runtime?.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
