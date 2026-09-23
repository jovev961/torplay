import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync,
  rmSync, writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildSync } from "esbuild";

export const NODE_VERSION = "24.21.0";
export const NODE_ARCHIVE = `node-v${NODE_VERSION}-linux-x64.tar.xz`;
export const NODE_SHA256 = "fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6";
export const TOOL_SHA256 = "ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0";
export const RUNTIME_SHA256 = "2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseRoot = path.join(root, ".release", "linux");
const stage = path.join(releaseRoot, "TorPlay.AppDir");
const cache = path.join(root, ".release", "cache");
const output = path.join(root, "dist", "linux");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status}.`);
}

export function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

async function verifiedDownload(url, filename, expected) {
  mkdirSync(cache, { recursive: true });
  const destination = path.join(cache, filename);
  if (existsSync(destination) && sha256(destination) === expected) return destination;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: ${url} (HTTP ${response.status}).`);
  const temporary = `${destination}.download`;
  writeFileSync(temporary, Buffer.from(await response.arrayBuffer()));
  const actual = sha256(temporary);
  if (actual !== expected) {
    rmSync(temporary, { force: true });
    throw new Error(`Checksum mismatch for ${filename}: ${actual}.`);
  }
  rmSync(destination, { force: true });
  cpSync(temporary, destination);
  rmSync(temporary, { force: true });
  return destination;
}

function bundle(entry, destination) {
  buildSync({
    entryPoints: [path.join(root, "scripts", entry)], outfile: destination,
    bundle: true, platform: "node", format: "esm", target: "node24", legalComments: "none",
  });
}

function findFiles(directory, basename, matches = []) {
  if (!existsSync(directory)) return matches;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) findFiles(file, basename, matches);
    else if (entry.name === basename) matches.push(file);
  }
  return matches;
}

export function isLinuxX64Elf(file) {
  const bytes = readFileSync(file).subarray(0, 20);
  return bytes.length === 20 && bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
    && bytes[4] === 2 && bytes[5] === 1 && bytes.readUInt16LE(18) === 62;
}

export function validateLinuxStage(directory = stage) {
  for (const required of [
    "AppRun", "torplay.desktop", "torplay.png", ".DirIcon",
    "usr/bin/node", "usr/lib/torplay/app/server.js",
    "usr/lib/torplay/runtime/linux-launcher.mjs",
    "usr/lib/torplay/runtime/runtime-watchdog.mjs",
  ]) {
    if (!existsSync(path.join(directory, required))) throw new Error(`Linux stage is missing ${required}.`);
  }
  const node = path.join(directory, "usr/bin/node");
  if (!isLinuxX64Elf(node)) throw new Error("Bundled Node is not a Linux x86_64 ELF binary.");
  const app = path.join(directory, "usr/lib/torplay/app");
  for (const basename of ["better_sqlite3.node", "ffmpeg", "ffprobe"]) {
    const matches = findFiles(app, basename);
    if (!matches.length || !matches.some(isLinuxX64Elf)) {
      throw new Error(`Standalone build lacks a Linux x86_64 ${basename}.`);
    }
  }
  if (findFiles(directory, ".env.local").length) throw new Error("Linux stage must not contain .env.local.");
}

async function stageAppDir() {
  rmSync(releaseRoot, { recursive: true, force: true });
  const app = path.join(stage, "usr/lib/torplay/app");
  const runtime = path.join(stage, "usr/lib/torplay/runtime");
  mkdirSync(runtime, { recursive: true });
  const standalone = path.join(root, ".next/standalone");
  if (!existsSync(path.join(standalone, "server.js"))) throw new Error("Standalone Next.js build is missing.");
  cpSync(standalone, app, { recursive: true });
  cpSync(path.join(root, ".next/static"), path.join(app, ".next/static"), { recursive: true });
  cpSync(path.join(root, "public"), path.join(app, "public"), { recursive: true });
  bundle("linux-launcher.js", path.join(runtime, "linux-launcher.mjs"));
  bundle("runtime-watchdog.js", path.join(runtime, "runtime-watchdog.mjs"));
  cpSync(path.join(root, "installer/linux/AppRun"), path.join(stage, "AppRun"));
  cpSync(path.join(root, "installer/linux/torplay.desktop"), path.join(stage, "torplay.desktop"));
  cpSync(path.join(root, "public/torplay-logo.png"), path.join(stage, "torplay.png"));
  cpSync(path.join(stage, "torplay.png"), path.join(stage, ".DirIcon"));
  chmodSync(path.join(stage, "AppRun"), 0o755);

  const archive = await verifiedDownload(
    `https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE}`, NODE_ARCHIVE, NODE_SHA256,
  );
  const extract = path.join(releaseRoot, "node-extract");
  mkdirSync(extract, { recursive: true });
  run("tar", ["-xJf", archive, "-C", extract]);
  const nodeRoot = path.join(extract, `node-v${NODE_VERSION}-linux-x64`);
  mkdirSync(path.join(stage, "usr/bin"), { recursive: true });
  cpSync(path.join(nodeRoot, "bin/node"), path.join(stage, "usr/bin/node"));
  cpSync(path.join(nodeRoot, "LICENSE"), path.join(stage, "usr/lib/torplay/NODE-LICENSE.txt"));
  chmodSync(path.join(stage, "usr/bin/node"), 0o755);
  rmSync(extract, { recursive: true, force: true });
  validateLinuxStage();
}

async function main() {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("npm run release:linux requires Linux x86_64 for native dependencies.");
  }
  run("npm", ["test"]);
  run("npm", ["run", "lint"]);
  run("npm", ["run", "build"], { env: { ...process.env, TORPLAY_STANDALONE_BUILD: "1" } });
  await stageAppDir();
  const tool = await verifiedDownload(
    "https://github.com/AppImage/appimagetool/releases/download/1.9.1/appimagetool-x86_64.AppImage",
    "appimagetool-1.9.1-x86_64.AppImage", TOOL_SHA256,
  );
  const imageRuntime = await verifiedDownload(
    "https://github.com/AppImage/type2-runtime/releases/download/20251108/runtime-x86_64",
    "appimage-runtime-20251108-x86_64", RUNTIME_SHA256,
  );
  chmodSync(tool, 0o755);
  mkdirSync(output, { recursive: true });
  const { version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const appImage = path.join(output, `TorPlay-${version}-x86_64.AppImage`);
  run(tool, ["--appimage-extract-and-run", "--runtime-file", imageRuntime, stage, appImage], {
    env: { ...process.env, ARCH: "x86_64", VERSION: version },
  });
  chmodSync(appImage, 0o755);
  writeFileSync(`${appImage}.sha256`, `${sha256(appImage)}  ${path.basename(appImage)}\n`);
  console.log(`Created ${appImage}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
