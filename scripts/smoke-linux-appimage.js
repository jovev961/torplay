import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(check, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(350);
  }
  throw new Error("Timed out waiting for the AppImage runtime.");
}

async function waitForExit(child, timeoutMs = 20_000) {
  if (child.exitCode !== null) return child.exitCode;
  return new Promise((resolve, reject) => {
    const onExit = (code) => { clearTimeout(timer); resolve(code); };
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      reject(new Error("AppImage did not exit after Quit."));
    }, timeoutMs);
    child.once("exit", onExit);
  });
}

export async function smokeLinuxAppImage(image) {
  if (process.platform !== "linux" || process.arch !== "x64") throw new Error("Linux x86_64 required.");
  const root = await mkdtemp(path.join(os.tmpdir(), "torplay-appimage-smoke-"));
  const bin = path.join(root, "bin");
  const state = path.join(root, "state");
  await mkdir(bin);
  const opener = path.join(bin, "xdg-open");
  await writeFile(opener, "#!/bin/sh\nprintf '%s\\n' \"$1\" >> \"$TORPLAY_SMOKE_BROWSER_LOG\"\n");
  await chmod(opener, 0o755);
  const environment = {
    ...process.env,
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_STATE_HOME: state,
    XDG_RUNTIME_DIR: path.join(root, "run"),
    TORPLAY_SMOKE_BROWSER_LOG: path.join(root, "browser.log"),
    PATH: `${bin}:${process.env.PATH}`,
  };
  const child = spawn(image, ["--appimage-extract-and-run"], { env: environment, stdio: "inherit" });
  let launchError;
  child.once("error", (error) => { launchError = error; });
  try {
    const status = await waitUntil(async () => {
      if (launchError || child.exitCode !== null) {
        throw launchError || new Error(`AppImage exited with code ${child.exitCode}.`);
      }
      const current = await readFile(path.join(state, "torplay/status.json"), "utf8")
        .then(JSON.parse).catch(() => null);
      return current?.state === "running" ? current : null;
    });
    assert.match(status.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal((await fetch(`${status.url}/api/health`)).status, 200);
    const access = await (await fetch(`${status.url}/api/network-access`)).json();
    assert.equal(access.scope, "desktop");
    assert.equal(access.lanUrl, null);
    assert.equal((await fetch(`${status.url}/api/playback/remote`)).status, 409);
    await waitUntil(async () => (await readFile(environment.TORPLAY_SMOKE_BROWSER_LOG, "utf8").catch(() => "")).includes(status.url));
    const second = spawn(image, ["--appimage-extract-and-run"], { env: environment, stdio: "inherit" });
    assert.equal(await waitForExit(second, 90_000), 0);
    const opened = await readFile(environment.TORPLAY_SMOKE_BROWSER_LOG, "utf8");
    assert.equal(opened.trim().split("\n").filter((line) => line === status.url).length, 2);
    const denied = await fetch(`${status.url}/api/runtime/quit`, { method: "POST" });
    assert.equal(denied.status, 403);
    const quit = await fetch(`${status.url}/api/runtime/quit`, {
      method: "POST",
      headers: { Origin: status.url, "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(quit.status, 202);
    assert.equal(await waitForExit(child), 0);
    console.log("AppImage startup, loopback access, browser open, Quit, and cleanup passed.");
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  smokeLinuxAppImage(path.resolve(process.argv[2] || "")).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
