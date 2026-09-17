import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const COMPONENT_NAMES = ["Docker", "Jackett", "FlareSolverr", "TorPlay", "mDNS"];

export function createInitialStatus({ pid = process.pid, url = "http://torplay.local", logPath = null } = {}) {
  return {
    state: "starting",
    pid,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    url,
    logPath,
    lastError: null,
    components: Object.fromEntries(COMPONENT_NAMES.map((name) => [name, "WAITING"])),
  };
}

export function createStatusReporter(filePath, initial = {}) {
  let status = { ...createInitialStatus(initial), ...initial };

  function write(update = {}) {
    status = {
      ...status,
      ...update,
      components: { ...status.components, ...(update.components || {}) },
      updatedAt: new Date().toISOString(),
    };
    if (filePath) {
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, `${JSON.stringify(status, null, 2)}\n`, "utf8");
    }
    return status;
  }

  return { get: () => ({ ...status, components: { ...status.components } }), write };
}

export function readRuntimeStatus(filePath) {
  if (!filePath || !existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}
