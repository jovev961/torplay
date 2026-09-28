import { spawn, spawnSync } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { access, lstat, readFile, rm, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { linuxPaths } from "./linux-paths.js";
import { sendControlCommand } from "./runtime-control.js";

export const TORPLAY_PACKAGE_NAME = "torplay";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function firstExecutable(candidates) {
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch { /* Try the next fixed executable. */ }
  }
  return null;
}

function runCommand(command, args, { capture = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: capture ? ["ignore", "pipe", "pipe"] : "ignore",
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => resolve({ code: null, error, stdout, stderr }));
    child.once("exit", (code) => resolve({ code, error: null, stdout, stderr }));
  });
}

function dialogAccepted(result, dialogName) {
  if (result?.error) {
    throw new Error(`${dialogName} could not start: ${result.error.message}`);
  }
  if (result?.code === 0) return true;
  if (result?.code === 1) return false;
  const detail = String(result?.stderr || "").trim().replace(/\s+/g, " ").slice(0, 240);
  const exit = Number.isInteger(result?.code) ? `exit code ${result.code}` : "an unknown error";
  throw new Error(`${dialogName} failed with ${exit}${detail ? `: ${detail}` : "."}`);
}

export function nativeRemovalCommand(family, executableExists = existsSync) {
  const candidates = family === "deb"
    ? [
        ["/usr/bin/apt-get", ["remove", "-y", TORPLAY_PACKAGE_NAME]],
        ["/usr/bin/dpkg", ["--remove", TORPLAY_PACKAGE_NAME]],
      ]
    : family === "rpm"
      ? [
          ["/usr/bin/dnf5", ["remove", "-y", TORPLAY_PACKAGE_NAME]],
          ["/usr/bin/dnf", ["remove", "-y", TORPLAY_PACKAGE_NAME]],
          ["/usr/bin/rpm", ["-e", TORPLAY_PACKAGE_NAME]],
        ]
      : [];
  const selected = candidates.find(([command]) => executableExists(command));
  if (!selected) throw new Error(`No supported ${family || "unknown"} package manager is available.`);
  return { command: selected[0], args: selected[1] };
}

export function isAllowedRemovalCommand({ command, args } = {}) {
  return [
    ["/usr/bin/apt-get", ["remove", "-y", TORPLAY_PACKAGE_NAME]],
    ["/usr/bin/dpkg", ["--remove", TORPLAY_PACKAGE_NAME]],
    ["/usr/bin/dnf5", ["remove", "-y", TORPLAY_PACKAGE_NAME]],
    ["/usr/bin/dnf", ["remove", "-y", TORPLAY_PACKAGE_NAME]],
    ["/usr/bin/rpm", ["-e", TORPLAY_PACKAGE_NAME]],
  ].some(([allowedCommand, allowedArgs]) => command === allowedCommand
    && Array.isArray(args) && args.length === allowedArgs.length
    && args.every((argument, index) => argument === allowedArgs[index]));
}

function packageInstalled(command, args, runSync, expectedOutput) {
  const result = runSync(command, args, expectedOutput ? { encoding: "utf8" } : { stdio: "ignore" });
  return result.status === 0 && (!expectedOutput || result.stdout?.trim() === expectedOutput);
}

export function detectInstalledPackage({
  executableExists = existsSync,
  runSync = spawnSync,
} = {}) {
  if (executableExists("/usr/bin/dpkg-query") && packageInstalled(
    "/usr/bin/dpkg-query", ["--show", "--showformat=${db:Status-Status}", TORPLAY_PACKAGE_NAME], runSync,
    "installed",
  )) return "deb";
  if (executableExists("/usr/bin/rpm")
    && packageInstalled("/usr/bin/rpm", ["-q", TORPLAY_PACKAGE_NAME], runSync)) return "rpm";
  throw new Error("The TorPlay system package is not installed.");
}

export async function confirmUninstall({
  findExecutable = firstExecutable,
  execute = runCommand,
} = {}) {
  const text = [
    "Uninstall TorPlay?",
    "",
    "This removes the TorPlay application.",
    "Your profiles, settings and history can be kept for a future reinstall.",
  ].join("\n");
  const zenity = await findExecutable(["/usr/bin/zenity", "/bin/zenity"]);
  if (zenity) {
    const confirmation = await execute(zenity, [
      "--question", "--title=TorPlay Uninstaller", `--text=${text}`,
      "--ok-label=Uninstall", "--cancel-label=Cancel", "--width=520",
    ], { capture: true });
    if (!dialogAccepted(confirmation, "Zenity uninstall confirmation")) {
      return { confirmed: false, deleteData: false };
    }
    const deletion = await execute(zenity, [
      "--question", "--title=TorPlay Uninstaller",
      "--text=Also delete your TorPlay profiles, settings, history, cache, and logs?",
      "--ok-label=Delete data", "--cancel-label=Keep data", "--width=520",
    ], { capture: true });
    return {
      confirmed: true,
      deleteData: dialogAccepted(deletion, "Zenity application-data choice"),
    };
  }

  const kdialog = await findExecutable(["/usr/bin/kdialog", "/bin/kdialog"]);
  if (kdialog) {
    const confirmation = await execute(kdialog, [
      "--title", "TorPlay Uninstaller", "--yesno", text,
      "--yes-label", "Uninstall", "--no-label", "Cancel",
    ], { capture: true });
    if (!dialogAccepted(confirmation, "KDialog uninstall confirmation")) {
      return { confirmed: false, deleteData: false };
    }
    const deletion = await execute(kdialog, [
      "--title", "TorPlay Uninstaller", "--yesno",
      "Also delete your TorPlay profiles, settings, history, cache, and logs?",
      "--yes-label", "Delete data", "--no-label", "Keep data",
    ], { capture: true });
    return {
      confirmed: true,
      deleteData: dialogAccepted(deletion, "KDialog application-data choice"),
    };
  }
  throw new Error("TorPlay Uninstaller requires Zenity or KDialog.");
}

async function showMessage(type, message, {
  findExecutable = firstExecutable,
  execute = runCommand,
} = {}) {
  const zenity = await findExecutable(["/usr/bin/zenity", "/bin/zenity"]);
  if (zenity) {
    await execute(zenity, [`--${type}`, "--title=TorPlay Uninstaller", `--text=${message}`, "--width=480"]);
    return;
  }
  const kdialog = await findExecutable(["/usr/bin/kdialog", "/bin/kdialog"]);
  if (kdialog) {
    await execute(kdialog, [type === "error" ? "--error" : "--msgbox", message,
      "--title", "TorPlay Uninstaller"]);
  }
}

async function readLock(paths, read = readFile) {
  try { return JSON.parse(await read(paths.lockPath, "utf8")); } catch { return null; }
}

export async function isTorPlaySupervisor(pid, read = readFile) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    const command = await read(`/proc/${pid}/cmdline`, "utf8");
    return command.split("\0").some((argument) =>
      argument.endsWith("/usr/lib/torplay/runtime/linux-launcher.mjs"));
  } catch {
    return false;
  }
}

function processIsAlive(pid, signal = process.kill) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { signal(pid, 0); return true; } catch { return false; }
}

export async function waitForProcessExit(pid, timeoutMs, {
  isAlive = processIsAlive,
  pause = delay,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await pause(100);
  }
  return !isAlive(pid);
}

export async function shutdownTorPlay({
  paths = linuxPaths(),
  sendStop = sendControlCommand,
  read = readFile,
  removeSocket = unlink,
  ownsProcess = isTorPlaySupervisor,
  waitForExit = waitForProcessExit,
  signal = process.kill,
} = {}) {
  const lock = await readLock(paths, read);
  try { await sendStop({ endpoint: paths.controlPath, timeoutMs: 5_000 }); } catch { /* No live socket. */ }
  if (lock?.pid && await waitForExit(lock.pid, 8_000)) {
    await removeSocket(paths.controlPath).catch(() => {});
    await removeSocket(paths.lockPath).catch(() => {});
    return { forced: false };
  }
  if (!lock?.pid) return { forced: false };
  if (!await ownsProcess(lock.pid, read)) {
    await removeSocket(paths.controlPath).catch(() => {});
    await removeSocket(paths.lockPath).catch(() => {});
    return { forced: false, stale: true };
  }
  signal(lock.pid, "SIGTERM");
  let forced = false;
  if (!await waitForExit(lock.pid, 3_000)) {
    signal(lock.pid, "SIGKILL");
    forced = true;
    if (!await waitForExit(lock.pid, 2_000)) {
      throw new Error("TorPlay did not stop; uninstall was cancelled.");
    }
  }
  await removeSocket(paths.controlPath).catch(() => {});
  await removeSocket(paths.lockPath).catch(() => {});
  return { forced };
}

function autostartPath(environment = process.env) {
  const configHome = environment.XDG_CONFIG_HOME?.trim();
  const root = configHome && path.isAbsolute(configHome)
    ? configHome : path.join(environment.HOME || os.homedir(), ".config");
  return path.join(root, "autostart", "torplay.desktop");
}

export function torPlayUserDataTargets(paths = linuxPaths()) {
  return [...new Set([paths.runtime, paths.config, paths.data, paths.cache, paths.state])];
}

export function isAllowedTorPlayDataPath(candidate, paths = linuxPaths()) {
  return torPlayUserDataTargets(paths).includes(path.resolve(candidate));
}

async function removeExactPath(target, { inspect = lstat, remove = rm, removeLink = unlink } = {}) {
  let stats;
  try { stats = await inspect(target); } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (stats.isSymbolicLink()) await removeLink(target);
  else await remove(target, { recursive: true, force: true });
}

export async function removeTorPlayUserData({
  paths = linuxPaths(),
  targets = torPlayUserDataTargets(paths),
  filesystem,
} = {}) {
  for (const target of targets) {
    if (!isAllowedTorPlayDataPath(target, paths)) {
      throw new Error(`Refusing to delete a non-TorPlay path: ${target}`);
    }
  }
  for (const target of targets.sort((left, right) => right.length - left.length)) {
    await removeExactPath(target, filesystem);
  }
}

export async function requestNativeRemoval(command, {
  findExecutable = firstExecutable,
  execute = runCommand,
} = {}) {
  if (!isAllowedRemovalCommand(command)) {
    throw new Error("Refusing a non-TorPlay package removal command.");
  }
  const pkexec = await findExecutable(["/usr/bin/pkexec", "/bin/pkexec"]);
  if (!pkexec) throw new Error("PolicyKit is required to authenticate package removal.");
  const result = await execute(pkexec, [command.command, ...command.args]);
  if (result.error || result.code !== 0) {
    throw new Error("TorPlay was not removed. Authentication was cancelled or the package manager failed.");
  }
}

export async function uninstallTorPlay({
  environment = process.env,
  paths = linuxPaths(environment),
  confirm = confirmUninstall,
  detectPackage = detectInstalledPackage,
  removalCommand = nativeRemovalCommand,
  shutdown = shutdownTorPlay,
  removePackage = requestNativeRemoval,
  removeData = removeTorPlayUserData,
  removeAutostart = removeExactPath,
} = {}) {
  const choice = await confirm();
  if (!choice.confirmed) return { cancelled: true };
  const family = detectPackage();
  await shutdown({ paths });
  await removePackage(removalCommand(family));
  await removeAutostart(autostartPath(environment));
  if (choice.deleteData) await removeData({ paths });
  return { cancelled: false, family, deleteData: choice.deleteData };
}

async function main() {
  if (process.platform !== "linux") throw new Error("TorPlay Uninstaller requires Linux.");
  const result = await uninstallTorPlay();
  if (!result.cancelled) {
    await showMessage("info", result.deleteData
      ? "TorPlay and its application data were removed."
      : "TorPlay was removed. Your profiles, settings, and history were kept.");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(async (error) => {
    await showMessage("error", error.message).catch(() => {});
    process.exitCode = 1;
  });
}
