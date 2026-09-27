import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync,
  realpathSync, rmSync, writeFileSync,
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

export function bundleLinuxRuntime(entry, destination) {
  buildSync({
    entryPoints: [path.join(root, "scripts", entry)], outfile: destination,
    bundle: true, platform: "node", format: "esm", target: "node24", legalComments: "none",
    banner: {
      js: `
import { createRequire as __torplayCreateRequire } from "node:module";
const require = __torplayCreateRequire(import.meta.url);
`,
    },
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

function findFilesWithExtension(directory, extension, matches = []) {
  if (!existsSync(directory)) return matches;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) findFilesWithExtension(file, extension, matches);
    else if (entry.name.endsWith(extension)) matches.push(file);
  }
  return matches;
}

export function isLinuxX64Elf(file) {
  const bytes = readFileSync(file).subarray(0, 20);
  return bytes.length === 20 && bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
    && bytes[4] === 2 && bytes[5] === 1 && bytes.readUInt16LE(18) === 62;
}

export function copyStandaloneBuild(source, destination) {
  cpSync(source, destination, { recursive: true, verbatimSymlinks: true });
}

export function debianPackageVersion(version) {
  return String(version).replace("-", "~");
}

export function rpmPackageMetadata(version) {
  const [upstream, ...prerelease] = String(version).split("-");
  return {
    version: upstream,
    release: prerelease.length ? `0.${prerelease.join("-").replace(/[^a-zA-Z0-9.]+/g, ".")}` : "1",
  };
}

export function validateLinuxInstallerPayload(directory) {
  for (const required of [
    "usr/bin/torplay", "usr/bin/torplay-autostart", "usr/bin/torplay-uninstaller",
    "usr/lib/torplay/node",
    "usr/lib/torplay/app/server.js", "usr/lib/torplay/app/node_modules/next/package.json",
    "usr/lib/torplay/app/node_modules/better-sqlite3/package.json",
    "usr/lib/torplay/runtime/linux-launcher.mjs",
    "usr/lib/torplay/runtime/linux-uninstaller.mjs",
    "usr/share/applications/torplay.desktop",
    "usr/share/applications/torplay-uninstaller.desktop",
    "usr/share/icons/hicolor/256x256/apps/torplay.png",
    "usr/share/metainfo/io.github.jovev961.TorPlay.metainfo.xml",
    "usr/share/doc/torplay/LICENSE",
  ]) {
    if (!existsSync(path.join(directory, required))) {
      throw new Error(`Linux installer payload is missing ${required}.`);
    }
  }
  if (existsSync(path.join(directory, "usr/bin/node"))) {
    throw new Error("Linux installer must not replace the system Node.js command.");
  }
}

export function stageLinuxInstallerPayload(sourceStage, destination) {
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(path.join(destination, "usr/bin"), { recursive: true });
  mkdirSync(path.join(destination, "usr/lib/torplay"), { recursive: true });
  mkdirSync(path.join(destination, "usr/share/applications"), { recursive: true });
  mkdirSync(path.join(destination, "usr/share/icons/hicolor/256x256/apps"), { recursive: true });
  mkdirSync(path.join(destination, "usr/share/metainfo"), { recursive: true });
  mkdirSync(path.join(destination, "usr/share/doc/torplay"), { recursive: true });
  cpSync(path.join(sourceStage, "usr/lib/torplay"), path.join(destination, "usr/lib/torplay"), {
    recursive: true, verbatimSymlinks: true,
  });
  cpSync(path.join(sourceStage, "usr/bin/node"), path.join(destination, "usr/lib/torplay/node"));
  cpSync(path.join(root, "installer/linux/torplay"), path.join(destination, "usr/bin/torplay"));
  cpSync(path.join(root, "installer/linux/torplay-autostart"),
    path.join(destination, "usr/bin/torplay-autostart"));
  cpSync(path.join(root, "installer/linux/torplay-uninstaller"),
    path.join(destination, "usr/bin/torplay-uninstaller"));
  bundleLinuxRuntime("linux-uninstaller.js",
    path.join(destination, "usr/lib/torplay/runtime/linux-uninstaller.mjs"));
  cpSync(path.join(root, "installer/linux/torplay-installed.desktop"),
    path.join(destination, "usr/share/applications/torplay.desktop"));
  cpSync(path.join(root, "installer/linux/torplay-uninstaller.desktop"),
    path.join(destination, "usr/share/applications/torplay-uninstaller.desktop"));
  cpSync(path.join(root, "installer/linux/io.github.jovev961.TorPlay.metainfo.xml"),
    path.join(destination, "usr/share/metainfo/io.github.jovev961.TorPlay.metainfo.xml"));
  cpSync(path.join(sourceStage, "torplay.png"),
    path.join(destination, "usr/share/icons/hicolor/256x256/apps/torplay.png"));
  cpSync(path.join(root, "LICENSE"), path.join(destination, "usr/share/doc/torplay/LICENSE"));
  for (const executable of [
    "usr/bin/torplay", "usr/bin/torplay-autostart", "usr/bin/torplay-uninstaller",
    "usr/lib/torplay/node",
  ]) {
    chmodSync(path.join(destination, executable), 0o755);
  }
  validateLinuxInstallerPayload(destination);
}

export function stageDebPackage(sourceStage, destination, version) {
  stageLinuxInstallerPayload(sourceStage, destination);
  mkdirSync(path.join(destination, "DEBIAN"), { recursive: true });
  writeFileSync(path.join(destination, "DEBIAN/control"), [
    "Package: torplay",
    `Version: ${debianPackageVersion(version)}`,
    "Section: video",
    "Priority: optional",
    "Architecture: amd64",
    "Maintainer: TorPlay <noreply@torplay.local>",
    "Depends: libc6 (>= 2.28), libgcc-s1, libstdc++6, policykit-1, zenity",
    "Recommends: xdg-utils",
    "Description: self-contained TorPlay home video application",
    " Discover and stream authorized torrent video with a bundled Node.js runtime",
    " and media tools. User data remains in the current user's XDG directories.",
    "",
  ].join("\n"));
}

export function rpmSpec(version) {
  const metadata = rpmPackageMetadata(version);
  return [
    "%global __os_install_post %{nil}",
    "Name: torplay",
    `Version: ${metadata.version}`,
    `Release: ${metadata.release}`,
    "Summary: Self-contained TorPlay home video application",
    "License: AGPL-3.0-only",
    "URL: https://github.com/jovev961/torplay",
    "BuildArch: x86_64",
    "AutoReqProv: no",
    "Requires: glibc, libgcc, libstdc++, polkit, zenity",
    "Recommends: xdg-utils",
    "",
    "%description",
    "Discover and stream authorized torrent video with a bundled Node.js runtime",
    "and media tools. User data remains in the current user's XDG directories.",
    "",
    "%prep",
    "",
    "%build",
    "",
    "%install",
    "rm -rf %{buildroot}",
    "mkdir -p %{buildroot}",
    "cp -a %{_sourcedir}/payload/. %{buildroot}/",
    "",
    "%files",
    "%license /usr/share/doc/torplay/LICENSE",
    "/usr/bin/torplay",
    "/usr/bin/torplay-autostart",
    "/usr/bin/torplay-uninstaller",
    "/usr/lib/torplay",
    "/usr/share/applications/torplay.desktop",
    "/usr/share/applications/torplay-uninstaller.desktop",
    "/usr/share/icons/hicolor/256x256/apps/torplay.png",
    "/usr/share/metainfo/io.github.jovev961.TorPlay.metainfo.xml",
    "",
  ].join("\n");
}

function validateBetterSqliteExternal(app) {
  const packageDirectory = path.join(app, "node_modules/better-sqlite3");
  const nativeBinary = path.join(packageDirectory, "build/Release/better_sqlite3.node");
  if (!existsSync(path.join(packageDirectory, "package.json"))) {
    throw new Error("Standalone build lacks the better-sqlite3 package.");
  }
  if (!existsSync(nativeBinary) || !isLinuxX64Elf(nativeBinary)) {
    throw new Error("Standalone build lacks a Linux x86_64 better_sqlite3.node.");
  }
  for (const dependency of ["bindings/bindings.js", "file-uri-to-path/index.js"]) {
    if (!existsSync(path.join(app, "node_modules", dependency))) {
      throw new Error(`Standalone better-sqlite3 dependency is missing ${dependency}.`);
    }
  }
  const externalDirectory = path.join(app, ".next/node_modules");
  const aliases = existsSync(externalDirectory)
    ? readdirSync(externalDirectory).filter((name) => name.startsWith("better-sqlite3-")) : [];
  if (!aliases.length) throw new Error("Standalone build lacks the hashed better-sqlite3 external.");
  const packageTarget = realpathSync(packageDirectory);
  for (const alias of aliases) {
    const filename = path.join(externalDirectory, alias);
    if (!lstatSync(filename).isSymbolicLink() || realpathSync(filename) !== packageTarget) {
      throw new Error("Standalone better-sqlite3 external must resolve inside the packaged app.");
    }
  }
}

export function validateLinuxStage(directory = stage) {
  for (const required of [
    "AppRun", "torplay.desktop", "torplay.png", ".DirIcon",
    "usr/bin/node", "usr/lib/torplay/app/server.js",
    "usr/lib/torplay/runtime/linux-launcher.mjs",
    "usr/lib/torplay/runtime/linux-port-helper.mjs",
    "usr/lib/torplay/runtime/runtime-watchdog.mjs",
  ]) {
    if (!existsSync(path.join(directory, required))) throw new Error(`Linux stage is missing ${required}.`);
  }
  const node = path.join(directory, "usr/bin/node");
  if (!isLinuxX64Elf(node)) throw new Error("Bundled Node is not a Linux x86_64 ELF binary.");
  const app = path.join(directory, "usr/lib/torplay/app");
  if (!existsSync(path.join(app, "node_modules/next/package.json"))) {
    throw new Error("Standalone build lacks the Next.js runtime package.");
  }
  validateBetterSqliteExternal(app);
  for (const basename of ["ffmpeg", "ffprobe"]) {
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
  copyStandaloneBuild(standalone, app);
  cpSync(path.join(root, ".next/static"), path.join(app, ".next/static"), { recursive: true });
  cpSync(path.join(root, "public"), path.join(app, "public"), { recursive: true });
  bundleLinuxRuntime("linux-launcher.js", path.join(runtime, "linux-launcher.mjs"));
  bundleLinuxRuntime("linux-port-helper.js", path.join(runtime, "linux-port-helper.mjs"));
  bundleLinuxRuntime("runtime-watchdog.js", path.join(runtime, "runtime-watchdog.mjs"));
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

function buildDebPackage(version) {
  const packageRoot = path.join(releaseRoot, "deb-root");
  stageDebPackage(stage, packageRoot, version);
  const destination = path.join(output, `TorPlay-${version}-amd64.deb`);
  run("dpkg-deb", ["--build", "--root-owner-group", packageRoot, destination]);
  writeFileSync(`${destination}.sha256`, `${sha256(destination)}  ${path.basename(destination)}\n`);
  return destination;
}

function buildRpmPackage(version) {
  const packageRoot = path.join(releaseRoot, "rpm-root");
  const sources = path.join(packageRoot, "SOURCES");
  const specs = path.join(packageRoot, "SPECS");
  const payload = path.join(sources, "payload");
  for (const directory of ["BUILD", "BUILDROOT", "RPMS", "SOURCES", "SPECS", "SRPMS"]) {
    mkdirSync(path.join(packageRoot, directory), { recursive: true });
  }
  stageLinuxInstallerPayload(stage, payload);
  const spec = path.join(specs, "torplay.spec");
  writeFileSync(spec, rpmSpec(version));
  run("rpmbuild", ["-bb", "--define", `_topdir ${packageRoot}`, spec]);
  const packages = findFilesWithExtension(path.join(packageRoot, "RPMS"), ".rpm");
  if (packages.length !== 1) throw new Error(`Expected one RPM package, found ${packages.length}.`);
  const destination = path.join(output, `TorPlay-${version}-x86_64.rpm`);
  cpSync(packages[0], destination);
  writeFileSync(`${destination}.sha256`, `${sha256(destination)}  ${path.basename(destination)}\n`);
  return destination;
}

async function main() {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("npm run release:linux requires Linux x86_64 for native dependencies.");
  }
  run("npm", ["test"]);
  run("npm", ["run", "lint"]);
  run("npm", ["run", "build"], { env: { ...process.env, TORPLAY_STANDALONE_BUILD: "1" } });
  await stageAppDir();
  mkdirSync(output, { recursive: true });
  const { version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const deb = buildDebPackage(version);
  const rpm = buildRpmPackage(version);
  const tool = await verifiedDownload(
    "https://github.com/AppImage/appimagetool/releases/download/1.9.1/appimagetool-x86_64.AppImage",
    "appimagetool-1.9.1-x86_64.AppImage", TOOL_SHA256,
  );
  const imageRuntime = await verifiedDownload(
    "https://github.com/AppImage/type2-runtime/releases/download/20251108/runtime-x86_64",
    "appimage-runtime-20251108-x86_64", RUNTIME_SHA256,
  );
  chmodSync(tool, 0o755);
  const appImage = path.join(output, `TorPlay-${version}-x86_64.AppImage`);
  run(tool, ["--appimage-extract-and-run", "--runtime-file", imageRuntime, stage, appImage], {
    env: { ...process.env, ARCH: "x86_64", VERSION: version },
  });
  chmodSync(appImage, 0o755);
  writeFileSync(`${appImage}.sha256`, `${sha256(appImage)}  ${path.basename(appImage)}\n`);
  console.log(`Created ${appImage}`);
  console.log(`Created ${deb}`);
  console.log(`Created ${rpm}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
