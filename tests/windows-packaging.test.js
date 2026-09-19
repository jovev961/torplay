import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveDockerCommand, resolveDockerDesktopCommand } from "../scripts/dev.js";
import {
  INNO_VERSION,
  NODE_VERSION,
  validateStage,
  windowsFileVersion,
} from "../scripts/release-windows.js";
import { sendControlCommand, startControlServer } from "../scripts/runtime-control.js";
import { createStatusReporter, readRuntimeStatus } from "../scripts/runtime-status.js";
import { installedEnvironment, installedPaths } from "../scripts/windows-paths.js";
import { createRotatingLog } from "../scripts/windows-runner.js";

test("Windows file versions are numeric and preserve beta build numbers", () => {
  assert.equal(windowsFileVersion("0.1.0-beta.2"), "0.1.0.2");
  assert.equal(windowsFileVersion("1.2.3"), "1.2.3.0");
  assert.throws(() => windowsFileVersion("1.2.3-rc.1"), /Unsupported/);
  assert.throws(() => windowsFileVersion("1.2.65536"), /out of range/);
});

test("Windows Docker discovery supports per-user and all-user installations", () => {
  const environment = { LOCALAPPDATA: "C:\\Users\\Owner\\AppData\\Local", ProgramFiles: "C:\\Program Files" };
  const perUserCli = path.join(environment.LOCALAPPDATA, "Programs", "DockerDesktop", "resources", "bin", "docker.exe");
  const allUserDesktop = path.join(environment.ProgramFiles, "Docker", "Docker", "Docker Desktop.exe");
  assert.equal(resolveDockerCommand({
    platform: "win32",
    environment,
    fileExists: (candidate) => candidate === perUserCli,
  }), perUserCli);
  assert.equal(resolveDockerDesktopCommand({
    platform: "win32",
    environment,
    fileExists: (candidate) => candidate === allUserDesktop,
  }), allUserDesktop);
});

test("installed paths are writable-data based and remain configurable", () => {
  const paths = installedPaths({ installDir: "C:\\Apps\\TorPlay", dataDir: "D:\\TorPlayData" });
  const environment = installedEnvironment(paths, { TORPLAY_DATABASE_PATH: "E:\\custom.db" });
  assert.equal(environment.TORPLAY_DATABASE_PATH, "E:\\custom.db");
  assert.equal(environment.TORPLAY_DEFAULT_DATABASE_PATH, path.join("D:\\TorPlayData", "data", "torplay.db"));
  assert.equal(environment.TORPLAY_CONFIG_PATH, path.join("D:\\TorPlayData", "config", "torplay.env"));
  assert.equal(environment.TORPLAY_SERVER_ENTRY, path.join("C:\\Apps\\TorPlay", "app", "server.js"));
  assert.equal(environment.COMPOSE_PROJECT_NAME, "torplay");
});

test("runtime status retains actionable failure details", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "torplay-status-"));
  const statusPath = path.join(directory, "runtime", "status.json");
  try {
    const reporter = createStatusReporter(statusPath);
    reporter.write({ components: { Docker: "OK" } });
    reporter.write({ state: "error", lastError: "Docker timed out" });
    const status = readRuntimeStatus(statusPath);
    assert.equal(status.components.Docker, "OK");
    assert.equal(status.lastError, "Docker timed out");
    assert.equal(status.state, "error");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the control channel requests a graceful supervisor stop", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "torplay-control-"));
  const endpoint = path.join(directory, "control.sock");
  let stops = 0;
  const control = await startControlServer({ endpoint, onStop: () => { stops += 1; } });
  try {
    assert.match(await sendControlCommand({ endpoint }), /^OK stopping/);
    assert.equal(stops, 1);
  } finally {
    await control.close();
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

test("release validation requires the packaged runtime and Windows native tools", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "torplay-stage-"));
  try {
    const files = [
      "runtime/node.exe",
      "runtime/home.mjs",
      "runtime/windows-runner.mjs",
      "runtime/windows-control.mjs",
      "app/server.js",
      "app/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
      "app/node_modules/ffmpeg-static/ffmpeg.exe",
      "app/node_modules/ffprobe-static/ffprobe.exe",
      "docker-compose.yml",
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

test("installer declares durable data, login startup, shortcuts, and firewall cleanup", async () => {
  const installer = await readFile(new URL("../installer/windows/torplay.iss", import.meta.url), "utf8");
  assert.match(installer, /PrivilegesRequired=lowest/);
  assert.match(installer, /Software\\Microsoft\\Windows\\CurrentVersion\\Run/);
  assert.match(installer, /Open TorPlay/);
  assert.match(installer, /Open TorPlay"; Filename: "http:\/\/localhost"/);
  assert.match(installer, /TorPlay Status/);
  assert.match(installer, /Start or Restart TorPlay/);
  assert.match(installer, /Stop TorPlay/);
  assert.match(installer, /windows-firewall\.ps1"" -Remove/);
  assert.match(installer, /uninsneveruninstall/);
  assert.match(installer, /VersionInfoVersion=\{#VersionInfoVersion\}/);
  assert.doesNotMatch(installer, /docker compose down/);
});

test("fresh Windows configuration leaves required provider credentials for browser setup", async () => {
  const template = await readFile(new URL("../installer/windows/torplay.env", import.meta.url), "utf8");
  assert.doesNotMatch(template, /^TMDB_API_TOKEN=/m);
  assert.doesNotMatch(template, /^JACKETT_API_KEY=/m);
  assert.match(template, /^JACKETT_MOVIE_INDEXERS=$/m);
  assert.match(template, /^JACKETT_SHOW_INDEXERS=$/m);
});

test("Windows installer workflow pins its toolchain and publishes verified artifacts", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/windows-installer.yml", import.meta.url),
    "utf8",
  );

  assert.match(workflow, /pull_request:\s*\n\s*branches: \[main, develop\]/);
  assert.match(workflow, /push:\s*\n\s*tags:\s*\n\s*- "v\*"/);
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
