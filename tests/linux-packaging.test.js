import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync,
  symlinkSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { linuxPaths, linuxRuntimeEnvironment } from "../scripts/linux-paths.js";
import {
  bundleLinuxRuntime, copyStandaloneBuild, debianPackageVersion, isLinuxX64Elf,
  rpmPackageMetadata, rpmSpec, stageDebPackage, validateLinuxInstallerPayload, validateLinuxStage,
} from "../scripts/release-linux.js";
import { networkAccessDetails } from "../lib/network/access.js";
import {
  availableLoopbackPort, linuxLanConfig, policyKitInstallCommand, prepareLinuxNextRuntime,
  resolveLinuxLanConfig, startLinuxApp,
} from "../scripts/linux-launcher.js";
import { enableUnprivilegedPort } from "../scripts/linux-port-helper.js";
import { sendControlCommand } from "../scripts/runtime-control.js";
import {
  confirmUninstall, detectInstalledPackage, isAllowedRemovalCommand, isAllowedTorPlayDataPath,
  nativeRemovalCommand,
  removeTorPlayUserData, requestNativeRemoval, shutdownTorPlay, torPlayUserDataTargets,
  uninstallTorPlay,
} from "../scripts/linux-uninstaller.js";

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

test("Linux paths use XDG storage and keep Next on loopback", () => temporaryDirectory((directory) => {
  const paths = linuxPaths({
    XDG_CONFIG_HOME: path.join(directory, "config"),
    XDG_DATA_HOME: path.join(directory, "data"),
    XDG_CACHE_HOME: path.join(directory, "cache"),
    XDG_STATE_HOME: path.join(directory, "state"),
    XDG_RUNTIME_DIR: path.join(directory, "run"),
  });
  assert.equal(paths.configPath, path.join(directory, "config/torplay/torplay.env"));
  assert.equal(paths.databasePath, path.join(directory, "data/torplay/torplay.db"));
  assert.equal(paths.nextRuntimePath, path.join(directory, "cache/torplay/next-runtime"));
  assert.equal(paths.controlPath, path.join(directory, "run/torplay/control.sock"));
  const environment = linuxRuntimeEnvironment(paths, { TORPLAY_HOST: "0.0.0.0" });
  assert.equal(environment.TORPLAY_HOST, "127.0.0.1");
  assert.equal(environment.TORPLAY_DISTRIBUTION, "linux-appimage");
}));

test("Linux LAN config prefers the standard torplay.local HTTP endpoint", () => {
  assert.deepEqual(linuxLanConfig({}), {
    publicHostname: "torplay.local",
    publicPort: 80,
    mdnsInterface: null,
  });
  assert.deepEqual(linuxLanConfig({
    TORPLAY_PUBLIC_HOSTNAME: "living-room.local",
    TORPLAY_PUBLIC_PORT: "8080",
    TORPLAY_MDNS_INTERFACE: "wlan0",
  }), {
    publicHostname: "living-room.local",
    publicPort: 8080,
    mdnsInterface: "wlan0",
  });
  assert.throws(() => linuxLanConfig({ TORPLAY_PUBLIC_HOSTNAME: "example.com" }), /valid \.local/);
  assert.throws(() => linuxLanConfig({ TORPLAY_PUBLIC_PORT: "0" }), /1 to 65535/);
});

test("Linux port selection authorizes port 80 and falls back safely", async () => {
  const config = linuxLanConfig({});
  let authorizationCalls = 0;
  const authorized = await resolveLinuxLanConfig(config, {
    probePort: async () => authorizationCalls ? { available: true } : { available: false, code: "EACCES" },
    authorizePort: async () => { authorizationCalls += 1; return true; },
  });
  assert.equal(authorized.publicPort, 80);
  assert.equal(authorizationCalls, 1);

  const cancelled = await resolveLinuxLanConfig(config, {
    probePort: async () => ({ available: false, code: "EACCES" }),
    authorizePort: async () => false,
  });
  assert.deepEqual(cancelled, { ...config, publicPort: 3000, fallbackFromPort: 80 });

  let occupiedAuthorizationCalls = 0;
  const occupied = await resolveLinuxLanConfig(config, {
    probePort: async () => ({ available: false, code: "EADDRINUSE" }),
    authorizePort: async () => { occupiedAuthorizationCalls += 1; return true; },
  });
  assert.equal(occupied.publicPort, 3000);
  assert.equal(occupiedAuthorizationCalls, 0);
});

test("PolicyKit installation is distro-specific and privileged helper writes exact settings", () => {
  assert.deepEqual(policyKitInstallCommand('ID=ubuntu\nID_LIKE="debian"\n'),
    ["apt-get", "install", "-y", "policykit-1"]);
  assert.deepEqual(policyKitInstallCommand("ID=fedora\n"), ["dnf", "install", "-y", "polkit"]);
  assert.deepEqual(policyKitInstallCommand("ID=arch\n"),
    ["pacman", "-S", "--needed", "--noconfirm", "polkit"]);
  assert.equal(policyKitInstallCommand("ID=unknown\n"), null);

  temporaryDirectory((directory) => {
    const procPath = path.join(directory, "ip_unprivileged_port_start");
    const configPath = path.join(directory, "99-torplay-ports.conf");
    writeFileSync(procPath, "1024\n");
    enableUnprivilegedPort({ uid: 0, procPath, configPath });
    assert.equal(readFileSync(procPath, "utf8"), "80\n");
    assert.match(readFileSync(configPath, "utf8"), /ip_unprivileged_port_start=80/);
    assert.throws(() => enableUnprivilegedPort({ uid: 1000, procPath, configPath }),
      /Administrator authorization/);
  });
});

test("Linux AppImage packaging runs only when manually requested", () => {
  const workflow = readFileSync(path.resolve(".github/workflows/linux-appimage.yml"), "utf8");
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /\b(pull_request|push):/);
  assert.match(workflow, /runs-on: ubuntu-24\.04/);
  assert.match(workflow, /sudo sysctl -w net\.ipv4\.ip_unprivileged_port_start=80/);
});

test("Linux native installer payload is self-contained and uses distro package versions", () => {
  temporaryDirectory((directory) => {
    const source = path.join(directory, "AppDir");
    const destination = path.join(directory, "deb-root");
    for (const item of [
      "usr/bin/node", "usr/lib/torplay/app/server.js",
      "usr/lib/torplay/app/node_modules/next/package.json",
      "usr/lib/torplay/app/node_modules/better-sqlite3/package.json",
      "usr/lib/torplay/runtime/linux-launcher.mjs", "torplay.png",
    ]) {
      const filename = path.join(source, item);
      mkdirSync(path.dirname(filename), { recursive: true });
      writeFileSync(filename, item === "usr/bin/node"
        ? "#!/bin/sh\nprintf '%s\\n' \"$@\"\n" : "fixture");
    }
    stageDebPackage(source, destination, "0.1.0-beta.2");
    validateLinuxInstallerPayload(destination);
    assert.equal(existsSync(path.join(destination, "usr/bin/node")), false);
    assert.equal((lstatSync(path.join(destination, "usr/bin/torplay")).mode & 0o111) !== 0, true);
    const launch = spawnSync(path.join(destination, "usr/bin/torplay"), ["--status"], {
      encoding: "utf8",
    });
    assert.equal(launch.status, 0);
    assert.equal(launch.stdout.trim(),
      `${path.join(destination, "usr/lib/torplay/runtime/linux-launcher.mjs")}\n--status`);
    const uninstall = spawnSync(path.join(destination, "usr/bin/torplay-uninstaller"), [], {
      encoding: "utf8",
    });
    assert.equal(uninstall.status, 0);
    assert.equal(uninstall.stdout.trim(),
      path.join(destination, "usr/lib/torplay/runtime/linux-uninstaller.mjs"));
    assert.match(readFileSync(
      path.join(destination, "usr/share/applications/torplay-uninstaller.desktop"), "utf8",
    ), /Name=TorPlay Uninstaller[\s\S]*Terminal=false/);
    assert.match(readFileSync(path.join(
      destination, "usr/share/metainfo/io.github.jovev961.TorPlay.metainfo.xml",
    ), "utf8"),
      /<launchable type="desktop-id">torplay\.desktop<\/launchable>/);
    assert.match(readFileSync(path.join(destination, "DEBIAN/control"), "utf8"),
      /Version: 0\.1\.0~beta\.2/);
    assert.equal(debianPackageVersion("1.2.3"), "1.2.3");
    assert.deepEqual(rpmPackageMetadata("0.1.0-beta.2"), {
      version: "0.1.0", release: "0.beta.2",
    });
    assert.match(rpmSpec("0.1.0-beta.2"), /BuildArch: x86_64/);
    assert.match(rpmSpec("0.1.0-beta.2"), /__os_install_post %\{nil\}/);
    assert.match(rpmSpec("0.1.0-beta.2"), /Requires: .*polkit, zenity/);
    assert.match(rpmSpec("0.1.0-beta.2"), /torplay-uninstaller\.desktop/);
  });
});

test("Linux uninstaller constructs only fixed native package removal actions", () => {
  assert.deepEqual(nativeRemovalCommand("deb", (file) => file === "/usr/bin/apt-get"), {
    command: "/usr/bin/apt-get", args: ["remove", "-y", "torplay"],
  });
  assert.deepEqual(nativeRemovalCommand("rpm", (file) => file === "/usr/bin/dnf5"), {
    command: "/usr/bin/dnf5", args: ["remove", "-y", "torplay"],
  });
  assert.throws(() => nativeRemovalCommand("other", () => true), /No supported other/);
  assert.equal(isAllowedRemovalCommand({
    command: "/usr/bin/apt-get", args: ["remove", "-y", "torplay"],
  }), true);
  assert.equal(isAllowedRemovalCommand({
    command: "/usr/bin/apt-get", args: ["remove", "-y", "another-package"],
  }), false);

  const deb = detectInstalledPackage({
    executableExists: (file) => file === "/usr/bin/dpkg-query",
    runSync: (command, args) => ({
      status: command === "/usr/bin/dpkg-query" && args.at(-1) === "torplay" ? 0 : 1,
      stdout: "installed\n",
    }),
  });
  assert.equal(deb, "deb");
  const rpm = detectInstalledPackage({
    executableExists: (file) => file === "/usr/bin/rpm",
    runSync: (command, args) => ({
      status: command === "/usr/bin/rpm" && args.join(" ") === "-q torplay" ? 0 : 1,
    }),
  });
  assert.equal(rpm, "rpm");
});

test("Linux uninstaller confirmation defaults to keeping data and handles cancellation", async () => {
  const findExecutable = async () => "/usr/bin/zenity";
  assert.deepEqual(await confirmUninstall({
    findExecutable,
    execute: async () => ({ code: 1, stdout: "", stderr: "" }),
  }), { confirmed: false, deleteData: false });
  assert.deepEqual(await confirmUninstall({
    findExecutable,
    execute: async () => ({ code: 0, stdout: "FALSE\n", stderr: "" }),
  }), { confirmed: true, deleteData: false });
  assert.deepEqual(await confirmUninstall({
    findExecutable,
    execute: async () => ({ code: 0, stdout: "TRUE\n", stderr: "" }),
  }), { confirmed: true, deleteData: true });
});

test("Linux uninstaller reports PolicyKit cancellation without claiming removal", async () => {
  await assert.rejects(requestNativeRemoval({ command: "/usr/bin/apt-get", args: ["remove", "-y", "torplay"] }, {
    findExecutable: async () => "/usr/bin/pkexec",
    execute: async () => ({ code: 126, error: null }),
  }), /Authentication was cancelled/);
  await assert.rejects(requestNativeRemoval({
    command: "/usr/bin/apt-get", args: ["remove", "-y", "another-package"],
  }), /non-TorPlay package/);
});

test("Linux uninstaller deletes only exact TorPlay XDG paths without following target symlinks", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "torplay-uninstaller-data-"));
  const environment = {
    HOME: path.join(directory, "home"),
    XDG_CONFIG_HOME: path.join(directory, "config"),
    XDG_DATA_HOME: path.join(directory, "data"),
    XDG_CACHE_HOME: path.join(directory, "cache"),
    XDG_STATE_HOME: path.join(directory, "state"),
    XDG_RUNTIME_DIR: path.join(directory, "run"),
  };
  const paths = linuxPaths(environment);
  const outside = path.join(directory, "outside");
  try {
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, "keep.txt"), "keep");
    for (const target of torPlayUserDataTargets(paths)) {
      if (target === paths.cache) continue;
      mkdirSync(target, { recursive: true });
      writeFileSync(path.join(target, "fixture"), "fixture");
    }
    mkdirSync(path.dirname(paths.cache), { recursive: true });
    symlinkSync(outside, paths.cache);
    assert.equal(isAllowedTorPlayDataPath(paths.data, paths), true);
    assert.equal(isAllowedTorPlayDataPath(path.join(directory, "data"), paths), false);
    await assert.rejects(removeTorPlayUserData({ paths, targets: [path.join(directory, "data")] }),
      /Refusing to delete/);
    await removeTorPlayUserData({ paths });
    assert.equal(existsSync(path.join(outside, "keep.txt")), true);
    for (const target of torPlayUserDataTargets(paths)) assert.equal(existsSync(target), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Linux uninstaller gracefully stops TorPlay and only force-signals its verified supervisor", async () => {
  const paths = { lockPath: "/run/torplay/runtime.lock", controlPath: "/run/torplay/control.sock" };
  const removed = [];
  const graceful = await shutdownTorPlay({
    paths,
    read: async () => JSON.stringify({ pid: 42 }),
    sendStop: async () => "OK stopping",
    waitForExit: async () => true,
    removeSocket: async (file) => { removed.push(file); },
    signal: () => { throw new Error("must not signal"); },
  });
  assert.deepEqual(graceful, { forced: false });
  assert.deepEqual(removed.sort(), [paths.controlPath, paths.lockPath].sort());

  const signals = [];
  const waits = [false, true];
  const terminated = await shutdownTorPlay({
    paths,
    read: async () => JSON.stringify({ pid: 84 }),
    sendStop: async () => { throw Object.assign(new Error("stale"), { code: "ENOENT" }); },
    waitForExit: async () => waits.shift(),
    ownsProcess: async () => true,
    removeSocket: async () => {},
    signal: (pid, name) => { signals.push([pid, name]); },
  });
  assert.deepEqual(terminated, { forced: false });
  assert.deepEqual(signals, [[84, "SIGTERM"]]);

  const staleRemoved = [];
  const stale = await shutdownTorPlay({
    paths,
    read: async () => JSON.stringify({ pid: 126 }),
    sendStop: async () => {},
    waitForExit: async () => false,
    ownsProcess: async () => false,
    removeSocket: async (file) => { staleRemoved.push(file); },
  });
  assert.deepEqual(stale, { forced: false, stale: true });
  assert.deepEqual(staleRemoved.sort(), [paths.controlPath, paths.lockPath].sort());
});

test("Linux uninstaller cancellation performs no shutdown or package action", async () => {
  let actions = 0;
  const result = await uninstallTorPlay({
    confirm: async () => ({ confirmed: false, deleteData: false }),
    detectPackage: () => { actions += 1; },
    shutdown: async () => { actions += 1; },
    removePackage: async () => { actions += 1; },
  });
  assert.deepEqual(result, { cancelled: true });
  assert.equal(actions, 0);
});

test("Linux uninstaller keeps data by default and deletes it only after explicit selection", async () => {
  const run = async (deleteData) => {
    const actions = [];
    const result = await uninstallTorPlay({
      environment: { HOME: "/home/tester" },
      paths: { config: "/config/torplay" },
      confirm: async () => ({ confirmed: true, deleteData }),
      detectPackage: () => "deb",
      removalCommand: () => ({ command: "/usr/bin/apt-get", args: ["remove", "-y", "torplay"] }),
      shutdown: async () => { actions.push("shutdown"); },
      removePackage: async () => { actions.push("package"); },
      removeAutostart: async () => { actions.push("autostart"); },
      removeData: async () => { actions.push("data"); },
    });
    return { actions, result };
  };
  assert.deepEqual((await run(false)).actions, ["shutdown", "package", "autostart"]);
  assert.deepEqual((await run(true)).actions, ["shutdown", "package", "autostart", "data"]);
});

test("Linux launcher ESM bundle supports CommonJS dependencies with dynamic requires", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "torplay-linux-bundle-"));
  const bundle = path.join(directory, "linux-launcher.mjs");
  try {
    bundleLinuxRuntime("linux-launcher.js", bundle);
    await import(`${pathToFileURL(bundle).href}?test=${Date.now()}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Linux stage rejects absent files, wrong native architecture, and secrets", () => temporaryDirectory((directory) => {
  const app = "usr/lib/torplay/app";
  const required = [
    "AppRun", "torplay.desktop", "torplay.png", ".DirIcon", "usr/bin/node",
    `${app}/server.js`, "usr/lib/torplay/runtime/linux-launcher.mjs",
    "usr/lib/torplay/runtime/linux-port-helper.mjs",
    "usr/lib/torplay/runtime/runtime-watchdog.mjs", `${app}/node_modules/next/package.json`,
    `${app}/node_modules/better-sqlite3/package.json`,
    `${app}/node_modules/better-sqlite3/build/Release/better_sqlite3.node`,
    `${app}/node_modules/bindings/bindings.js`, `${app}/node_modules/file-uri-to-path/index.js`,
    `${app}/ffmpeg`, `${app}/ffprobe`,
  ];
  assert.throws(() => validateLinuxStage(directory), /missing AppRun/);
  for (const item of required) {
    const filename = path.join(directory, item);
    mkdirSync(path.dirname(filename), { recursive: true });
    writeFileSync(filename, /(?:better_sqlite3\.node|usr\/bin\/node|ffmpeg|ffprobe)$/.test(item) ? elf() : "fixture");
  }
  const external = path.join(directory, app, ".next/node_modules/better-sqlite3-fixture");
  mkdirSync(path.dirname(external), { recursive: true });
  symlinkSync("../../node_modules/better-sqlite3", external);
  validateLinuxStage(directory);
  assert.equal(isLinuxX64Elf(path.join(directory, "usr/bin/node")), true);
  writeFileSync(path.join(directory, "usr/lib/torplay/app/.env.local"), "SECRET=fixture");
  assert.throws(() => validateLinuxStage(directory), /must not contain/);
  rmSync(path.join(directory, "usr/lib/torplay/app/.env.local"));
  writeFileSync(path.join(directory, "usr/lib/torplay/app/ffmpeg"), "wrong architecture");
  assert.throws(() => validateLinuxStage(directory), /ffmpeg/);
  assert.equal(readFileSync(path.join(directory, "AppRun"), "utf8"), "fixture");
}));

test("Linux staging preserves self-contained Next external symlinks", () => temporaryDirectory((directory) => {
  const source = path.join(directory, "standalone");
  const destination = path.join(directory, "staged-app");
  mkdirSync(path.join(source, ".next/node_modules"), { recursive: true });
  mkdirSync(path.join(source, "node_modules/better-sqlite3"), { recursive: true });
  symlinkSync("../../node_modules/better-sqlite3",
    path.join(source, ".next/node_modules/better-sqlite3-fixture"));
  copyStandaloneBuild(source, destination);
  const copied = path.join(destination, ".next/node_modules/better-sqlite3-fixture");
  assert.equal(lstatSync(copied).isSymbolicLink(), true);
  assert.equal(readlinkSync(copied), "../../node_modules/better-sqlite3");
}));

test("Linux runtime mirrors .next into XDG cache and resolves packaged externals", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "torplay-linux-next-runtime-"));
  const packaged = path.join(directory, "packaged-app");
  const packageDirectory = path.join(packaged, "node_modules/better-sqlite3");
  mkdirSync(path.join(packaged, ".next/node_modules"), { recursive: true });
  mkdirSync(packageDirectory, { recursive: true });
  mkdirSync(path.join(packaged, "node_modules/next"), { recursive: true });
  writeFileSync(path.join(packaged, "server.js"), "// fixture");
  writeFileSync(path.join(packaged, ".next/BUILD_ID"), "fixture-build\n");
  writeFileSync(path.join(packageDirectory, "package.json"), "{}");
  writeFileSync(path.join(packaged, "node_modules/next/package.json"), "{}");
  symlinkSync("../../node_modules/better-sqlite3",
    path.join(packaged, ".next/node_modules/better-sqlite3-fixture"));
  const paths = linuxPaths({
    XDG_CACHE_HOME: path.join(directory, "cache"),
  });
  try {
    const staleRuntime = path.join(paths.nextRuntimePath, "fixture-build");
    mkdirSync(staleRuntime, { recursive: true });
    writeFileSync(path.join(staleRuntime, "server.js"), "// incomplete old layout");
    writeFileSync(path.join(staleRuntime, ".torplay-runtime-ready"), "fixture-build\n");
    const server = await prepareLinuxNextRuntime(paths, path.join(packaged, "server.js"));
    const runtimeRoot = path.dirname(server);
    const external = path.join(runtimeRoot, ".next/node_modules/better-sqlite3-fixture");
    assert.equal(runtimeRoot.startsWith(paths.nextRuntimePath), true);
    assert.equal(existsSync(path.join(runtimeRoot, ".next/cache")), true);
    assert.equal(readlinkSync(external), "../../node_modules/better-sqlite3");
    assert.equal(readFileSync(path.join(external, "package.json"), "utf8"), "{}");
    assert.equal(lstatSync(path.join(runtimeRoot, "node_modules")).isDirectory(), true);
    assert.equal(readFileSync(path.join(runtimeRoot, "node_modules/next/package.json"), "utf8"), "{}");
    assert.equal(readFileSync(path.join(runtimeRoot, ".torplay-runtime-ready"), "utf8"),
      "fixture-build:2\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Linux network details advertise the supervised LAN endpoint", () => {
  const request = new Request("http://127.0.0.1:39123/api/network-access");
  const details = networkAccessDetails(request, {
    environment: {
      TORPLAY_DISTRIBUTION: "linux-appimage",
      TORPLAY_SUPERVISOR_PID: "42",
      TORPLAY_PUBLIC_HOSTNAME: "torplay.local",
      TORPLAY_PUBLIC_PORT: "3000",
    },
    interfaces: { eth0: [{ family: "IPv4", address: "192.168.1.22", internal: false }] },
  });
  assert.deepEqual(details, {
    hostnameUrl: "http://torplay.local:3000",
    lanAddress: "192.168.1.22",
    lanUrl: "http://192.168.1.22:3000",
  });
});

test("Linux supervisor starts a LAN proxy and mDNS, then Quit cleans up", async () => {
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
  let mdnsOptions;
  let mdnsStopped = false;
  let runtime;
  const publicPort = await availableLoopbackPort();
  try {
    runtime = await startLinuxApp({
      paths, environment: { TORPLAY_PUBLIC_PORT: String(publicPort) }, serverEntry: server,
      watchdogEntry: path.resolve("scripts/runtime-watchdog.js"),
      openBrowser: async (url) => { browserUrl = url; return true; },
      startMdns: async (options) => {
        mdnsOptions = options;
        return { hostname: "torplay-2.local", stop: async () => { mdnsStopped = true; } };
      },
    });
    assert.equal(browserUrl, runtime.url);
    assert.equal(runtime.url, `http://127.0.0.1:${publicPort}`);
    assert.equal(runtime.networkUrl, `http://torplay-2.local:${publicPort}`);
    assert.deepEqual(mdnsOptions, {
      hostname: "torplay.local", port: publicPort, mdnsInterface: null,
    });
    assert.equal((await fetch(`${runtime.url}/api/health`)).status, 200);
    assert.deepEqual(runtime.reporter.get().components, {
      TorPlay: "OK", "LAN proxy": "OK", mDNS: "OK",
    });
    assert.equal(runtime.reporter.get().networkUrl, runtime.networkUrl);
    assert.equal(existsSync(paths.controlPath), true);
    await sendControlCommand({ endpoint: paths.controlPath });
    await new Promise((resolve) => runtime.child.once("exit", resolve));
    await runtime.stop();
    assert.equal(mdnsStopped, true);
    assert.equal(existsSync(paths.lockPath), false);
    assert.equal(existsSync(paths.controlPath), false);
  } finally {
    await runtime?.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
